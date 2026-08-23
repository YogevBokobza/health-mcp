import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { HealthFundTypes, type HealthDocument } from 'israeli-health-scrapers';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-mcp-documents-test-'));
process.env.HEALTH_MCP_DATA_DIR = tempDir;
process.env.HEALTH_MCP_KEY = 'fictional-documents-test-key';
process.env.HEALTH_MCP_AUDIT = 'off';

const { DocumentDecryptError, DocumentExistsError, DocumentIntegrityError, exportDocument, loadDocument, saveDocument } =
  await import('../../src/store/documents.js');

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function fictionalDocument(content = 'fictional pdf bytes, not a real report'): HealthDocument {
  return {
    fileName: 'בדיקת דמיון — לא אמיתי.pdf',
    contentType: 'application/pdf',
    byteLength: Buffer.byteLength(content),
    content: Buffer.from(content).toString('base64'),
  };
}

describe('saveDocument', () => {
  it('names the file opaquely from the record id, with no test name or date', () => {
    const stored = saveDocument(HealthFundTypes.maccabi, 'lab_result::11111111', fictionalDocument());

    expect(path.basename(stored.path)).not.toMatch(/דמיון|pdf$/i);
    expect(path.basename(stored.path)).toMatch(/^lab_result_11111111/);
  });

  it('writes ciphertext, not the plaintext PDF bytes, to disk', () => {
    const content = 'fictional plaintext marker that must never appear encrypted';
    const stored = saveDocument(HealthFundTypes.maccabi, 'fictional-plaintext-check', fictionalDocument(content));

    const raw = fs.readFileSync(stored.path);
    expect(raw.includes(Buffer.from(content))).toBe(false);
  });

  it('reports the plaintext byte length and checksum, not the ciphertext file size', () => {
    const content = 'fictional checksum content';
    const stored = saveDocument(HealthFundTypes.maccabi, 'fictional-checksum-check', fictionalDocument(content));

    expect(stored.byteLength).toBe(Buffer.byteLength(content));
    expect(stored.sha256).toBe(crypto.createHash('sha256').update(content).digest('hex'));
  });
});

describe('loadDocument', () => {
  it('round-trips the exact original bytes', () => {
    const content = 'fictional round-trip content, בעברית גם';
    const stored = saveDocument(HealthFundTypes.maccabi, 'fictional-roundtrip', fictionalDocument(content));

    expect(loadDocument(stored.path, stored.sha256).toString('utf8')).toBe(content);
  });

  it('raises a clear error when the checksum does not match', () => {
    const stored = saveDocument(HealthFundTypes.maccabi, 'fictional-bad-checksum', fictionalDocument());
    expect(() => loadDocument(stored.path, 'not-the-real-checksum')).toThrow(DocumentIntegrityError);
  });

  it('raises a clear error, not a garbled read, when the key is wrong', () => {
    const stored = saveDocument(HealthFundTypes.maccabi, 'fictional-wrong-key', fictionalDocument());

    const originalKey = process.env.HEALTH_MCP_KEY;
    process.env.HEALTH_MCP_KEY = 'a-completely-different-fictional-key';
    try {
      expect(() => loadDocument(stored.path, stored.sha256)).toThrow(DocumentDecryptError);
    } finally {
      process.env.HEALTH_MCP_KEY = originalKey;
    }
  });

  it('raises a clear error on a corrupted file rather than returning garbage bytes', () => {
    const stored = saveDocument(HealthFundTypes.maccabi, 'fictional-corrupted', fictionalDocument());
    const corrupted = fs.readFileSync(stored.path);
    corrupted[corrupted.length - 1] = (corrupted[corrupted.length - 1]! + 1) % 256;
    fs.writeFileSync(stored.path, corrupted);

    expect(() => loadDocument(stored.path, stored.sha256)).toThrow(DocumentDecryptError);
  });
});

describe('exportDocument', () => {
  const exportPath = path.join(tempDir, 'exported-fictional-report.pdf');

  afterEach(() => {
    fs.rmSync(exportPath, { force: true });
  });

  it('decrypts to the destination as plain, readable bytes', () => {
    const content = 'fictional export content';
    const stored = saveDocument(HealthFundTypes.maccabi, 'fictional-export', fictionalDocument(content));

    exportDocument(stored.path, stored.sha256, exportPath);

    expect(fs.readFileSync(exportPath, 'utf8')).toBe(content);
  });

  it('refuses to overwrite an existing destination without the flag', () => {
    fs.writeFileSync(exportPath, 'something already here');
    const stored = saveDocument(HealthFundTypes.maccabi, 'fictional-export-refuse', fictionalDocument());

    expect(() => exportDocument(stored.path, stored.sha256, exportPath)).toThrow(DocumentExistsError);
    expect(fs.readFileSync(exportPath, 'utf8')).toBe('something already here');
  });

  it('overwrites when explicitly told to', () => {
    fs.writeFileSync(exportPath, 'stale content');
    const content = 'fictional fresh export content';
    const stored = saveDocument(HealthFundTypes.maccabi, 'fictional-export-overwrite', fictionalDocument(content));

    exportDocument(stored.path, stored.sha256, exportPath, { overwrite: true });

    expect(fs.readFileSync(exportPath, 'utf8')).toBe(content);
  });
});
