import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { HealthDocument, HealthFundId } from 'israeli-health-scrapers';

import { documentsDir } from '../config/paths.js';
import { encryptionKey } from '../db/database.js';

export class DocumentDecryptError extends Error {
  readonly code = 'DOCUMENT_DECRYPT';
}

export class DocumentIntegrityError extends Error {
  readonly code = 'DOCUMENT_INTEGRITY';
}

export class DocumentExistsError extends Error {
  readonly code = 'DOCUMENT_EXISTS';
}

export interface StoredDocument {
  path: string;
  byteLength: number;
  sha256: string;
}

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * A distinct label from anything the database key derivation uses, so the two derived
 * keys can never collide even though both start from the same `HEALTH_MCP_KEY`.
 */
const DOCUMENT_KEY_INFO = Buffer.from('health-mcp:documents:v1', 'utf8');
const DOCUMENT_KEY_SALT = Buffer.from('health-mcp:documents:salt:v1', 'utf8');

function documentEncryptionKey(): Buffer {
  return Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(encryptionKey(), 'utf8'), DOCUMENT_KEY_SALT, DOCUMENT_KEY_INFO, 32),
  );
}

/**
 * A file name that carries no medical information — no test name, no date — because
 * the record's own id (already opaque: a fund's internal type/request id) is all that
 * identifies it. Unsafe filesystem characters are replaced rather than the id being
 * hashed, so the same result always lands at the same, still-unreadable, path.
 */
function fileNameFor(recordId: string): string {
  return `${recordId.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 180)}.enc`;
}

function encrypt(plaintext: Buffer): Buffer {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', documentEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

function decrypt(blob: Buffer): Buffer {
  const iv = blob.subarray(0, IV_LENGTH);
  const authTag = blob.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = blob.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', documentEncryptionKey(), iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // GCM's tag check fails identically for "wrong key" and "corrupted file" — both
    // are the same actionable fact to a caller: this document cannot be trusted.
    throw new DocumentDecryptError(
      'Could not decrypt the stored document: the encryption key does not match, or the file is corrupt.',
    );
  }
}

/**
 * Encrypts and writes one result/summary document under the fund's documents
 * directory, opaquely named by the record's own id.
 *
 * Rewrites the file every time rather than skipping when it already exists: a
 * half-written file from an interrupted fetch is indistinguishable from a complete one
 * by name alone, and a document is small enough that rewriting it is cheaper than being
 * wrong about it.
 */
export function saveDocument(
  companyId: HealthFundId,
  recordId: string,
  document: HealthDocument,
): StoredDocument {
  const directory = documentsDir(companyId);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

  const content = Buffer.from(document.content, 'base64');
  const file = path.join(directory, fileNameFor(recordId));

  fs.writeFileSync(file, encrypt(content), { mode: 0o600 });

  return {
    path: file,
    byteLength: content.length,
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
  };
}

/**
 * Decrypts a stored document and verifies it against the checksum recorded when it was
 * saved — the record row and the file on disk can drift apart (a hand-edited row, a
 * file swapped out from under the app), and a caller decrypting a document is exactly
 * the moment that mismatch needs to surface instead of silently handing back the wrong
 * bytes.
 */
export function loadDocument(storedPath: string, expectedSha256: string): Buffer {
  const plaintext = decrypt(fs.readFileSync(storedPath));
  const actual = crypto.createHash('sha256').update(plaintext).digest('hex');

  if (actual !== expectedSha256) {
    throw new DocumentIntegrityError(
      `Stored document at ${storedPath} does not match its recorded checksum.`,
    );
  }

  return plaintext;
}

/**
 * Decrypts a stored document to a path the caller chooses, as a plain, readable file.
 *
 * Refuses to overwrite an existing file unless told to — decrypting a medical document
 * onto something already there is exactly the kind of mistake that deserves an explicit
 * flag, not a silent clobber.
 */
export function exportDocument(
  storedPath: string,
  expectedSha256: string,
  destinationPath: string,
  { overwrite = false }: { overwrite?: boolean } = {},
): void {
  if (!overwrite && fs.existsSync(destinationPath)) {
    throw new DocumentExistsError(
      `${destinationPath} already exists. Pass overwrite to replace it.`,
    );
  }

  const plaintext = loadDocument(storedPath, expectedSha256);
  fs.writeFileSync(destinationPath, plaintext, { mode: 0o600, flag: overwrite ? 'w' : 'wx' });
}
