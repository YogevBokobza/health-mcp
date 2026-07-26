import { zodToJsonSchema } from 'zod-to-json-schema';
import { z } from 'zod';
import { SCRAPERS } from 'israeli-health-scrapers';

import { allOperations, configuredFunds, type Operation } from '../operations.js';
import type { PermissionEngine } from '../permissions/engine.js';

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  operation: Operation;
}

/**
 * Tool names stay unqualified while a single fund is configured (`medications_list`)
 * and gain a fund prefix once more than one is (`maccabi_medications_list`).
 *
 * The input schema is identical either way, so a prompt written against one fund keeps
 * working when a second is added. Fund-independent operations are never prefixed.
 */
export function toolNameFor(operation: Operation, qualify: boolean): string {
  const base = operation.name.replace(/\./g, '_');
  return qualify && operation.companyId ? `${operation.companyId}_${base}` : base;
}

/**
 * The tool list for the current policy.
 *
 * Only operations the profile may call are returned — an agent is never shown a tool it
 * would be refused for, so it cannot report a capability the member did not grant.
 */
export function buildToolDescriptors(permissions: PermissionEngine): McpToolDescriptor[] {
  const qualify = configuredFunds().length > 1;

  return permissions.visibleOperations(allOperations()).map((operation) => ({
    name: toolNameFor(operation, qualify),
    description: describe(operation),
    inputSchema: toolInputSchema(operation),
    operation,
  }));
}

function describe(operation: Operation): string {
  const who = operation.companyId ? SCRAPERS[operation.companyId].name : 'אחסון מקומי';
  const what = operation.capability === 'write' ? 'כתיבה' : 'קריאה';
  return `[${who} · ${what}] ${operation.title}`;
}

/**
 * The tool's input schema: the operation's own input, plus `confirmationToken` for
 * write operations, so the confirm round-trip is a visible part of the contract rather
 * than something the agent must infer from an error.
 */
function toolInputSchema(operation: Operation): Record<string, unknown> {
  const schema =
    operation.capability === 'write'
      ? z.intersection(
          operation.input as z.ZodType<unknown>,
          z.object({
            confirmationToken: z
              .string()
              .optional()
              .describe(
                'Token from the previous preview call. Omit on the first call to receive a preview.',
              ),
          }),
        )
      : (operation.input as z.ZodType<unknown>);

  return zodToJsonSchema(schema, { target: 'jsonSchema7' }) as Record<string, unknown>;
}
