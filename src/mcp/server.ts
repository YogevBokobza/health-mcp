#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { SCRAPERS, createScraper, type HealthFundId } from 'israeli-health-scrapers';

import { PermissionEngine } from '../permissions/engine.js';
import {
  ConfirmationRequiredError,
  PermissionDeniedError,
  RateLimitedError,
} from '../permissions/engine.js';
import { buildToolDescriptors } from './tools.js';
import {
  closeAllChallenges,
  createChallenge,
  finishChallenge,
  sweepExpiredChallenges,
  takeChallenge,
} from './auth-challenges.js';
import { configuredFunds } from '../operations.js';
import { requireCredentials } from '../db/credentials.js';
import { DatabaseKeyError, closeDatabase } from '../db/database.js';
import { UnsafeQueryError } from '../db/query.js';
import { scraperDataDir } from '../config/paths.js';

const permissions = new PermissionEngine();

const AUTH_START_TOOL = 'auth_start';
const AUTH_COMPLETE_TOOL = 'auth_complete';

// Keep the library's sessions and diagnostics inside our app data dir.
process.env.IHS_DATA_DIR ??= scraperDataDir();

function log(message: string, fields: Record<string, unknown> = {}): void {
  // stderr only: stdout carries the MCP protocol stream.
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), message, ...fields })}\n`);
}

/**
 * Auth tools are always listed, whatever the policy says.
 *
 * Logging in is not a privileged operation — it is the precondition for every other one
 * — and an agent that cannot see how to re-authenticate has no way to recover from an
 * expired session except by failing over and over.
 */
function authTools() {
  const funds = configuredFunds();

  return [
    {
      name: AUTH_START_TOOL,
      description:
        'התחלת התחברות לקופת חולים. אם נדרש אימות SMS — מוחזר challengeId וקוד נשלח לטלפון של המבוטח, ויש להשלים עם auth_complete.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          companyId: {
            type: 'string',
            enum: funds.length > 0 ? funds : Object.keys(SCRAPERS),
            description: 'The health fund to log in to.',
          },
        },
        required: ['companyId'],
      },
    },
    {
      name: AUTH_COMPLETE_TOOL,
      description: 'השלמת ההתחברות עם קוד ה-SMS שהתקבל.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          challengeId: { type: 'string' },
          code: { type: 'string', description: 'The one-time code from the SMS.' },
        },
        required: ['challengeId', 'code'],
      },
    },
  ];
}

function jsonResult(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function errorPayload(payload: Record<string, unknown>): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

/**
 * Turns a thrown value into a result the agent can act on.
 *
 * A refusal and a confirmation prompt are not malfunctions — they are the point of this
 * server — so each carries the specific next step rather than a stack trace.
 */
function errorResult(error: unknown): CallToolResult {
  if (error instanceof ConfirmationRequiredError) {
    return errorPayload({
      status: 'confirmation_required',
      preview: error.preview,
      confirmationToken: error.confirmationToken,
      expiresInSeconds: error.expiresInSeconds,
      next: 'Show the preview to the user. If they approve, call again with the same arguments plus confirmationToken.',
    });
  }

  if (error instanceof PermissionDeniedError) {
    return errorPayload({ status: 'permission_denied', message: error.message });
  }

  if (error instanceof RateLimitedError) {
    return errorPayload({
      status: 'rate_limited',
      message: error.message,
      retryAfterSeconds: error.retryAfterSeconds,
    });
  }

  if (error instanceof UnsafeQueryError) {
    return errorPayload({ status: 'unsafe_query', message: error.message });
  }

  if (error instanceof DatabaseKeyError) {
    return errorPayload({
      status: 'database_locked',
      message: error.message,
      next: 'Set HEALTH_MCP_KEY in the server environment and restart it.',
    });
  }

  const message = error instanceof Error ? error.message : String(error);
  log('tool error', { message });
  return errorPayload({ status: 'error', message });
}

const server = new Server(
  { name: 'health-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  let descriptors: ReturnType<typeof buildToolDescriptors> = [];

  try {
    descriptors = buildToolDescriptors(permissions);
  } catch (error) {
    // A locked or missing database must not make the server unusable: the auth tools
    // still list, and the error surfaces when a tool is actually called.
    log('could not build tool list', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  log('tools listed', {
    profile: permissions.profileName,
    readOnlyMode: permissions.readOnlyMode,
    count: descriptors.length,
  });

  return {
    tools: [
      ...authTools(),
      ...descriptors.map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema: inputSchema as { type: 'object' },
      })),
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    if (name === AUTH_START_TOOL) {
      const { companyId } = args as { companyId: HealthFundId };
      const credentials = requireCredentials(companyId);

      const scraper = createScraper({ companyId, storeSession: true });
      if (!scraper.triggerTwoFactorAuth) {
        throw new Error(`${SCRAPERS[companyId].name} does not support a split OTP login.`);
      }

      const result = await scraper.triggerTwoFactorAuth(credentials);
      if (!result.success) {
        await scraper.terminate(false);
        return errorPayload({
          status: 'auth_failed',
          errorType: result.errorType,
          message: result.errorMessage,
        });
      }

      // The scraper keeps its browser open under the challenge id; closing it here
      // would invalidate the code the member is about to receive.
      const challenge = createChallenge(companyId, scraper);
      return jsonResult({
        status: 'awaiting_otp',
        challengeId: challenge.challengeId,
        expiresInSeconds: Math.round((challenge.expiresAt - Date.now()) / 1000),
        next: `Ask the user for the SMS code, then call ${AUTH_COMPLETE_TOOL}.`,
      });
    }

    if (name === AUTH_COMPLETE_TOOL) {
      const { challengeId, code } = args as { challengeId: string; code: string };
      const challenge = takeChallenge(challengeId);

      if (!challenge) {
        return errorPayload({
          status: 'error',
          message: 'That login challenge is unknown or expired. Start a new login.',
        });
      }

      try {
        const result = await challenge.scraper.getLongTermTwoFactorToken?.(code);
        if (!result?.success) {
          return errorPayload({ status: 'auth_failed', message: 'The code was rejected.' });
        }
        return jsonResult({ status: 'authenticated', companyId: challenge.companyId });
      } finally {
        finishChallenge(challengeId);
        await challenge.scraper.terminate(true).catch(() => {});
      }
    }

    // Re-derive the visible tool set on every call: resolving the name against the same
    // policy-filtered list the agent was shown is what keeps discovery and execution
    // from drifting apart.
    const descriptor = buildToolDescriptors(permissions).find((tool) => tool.name === name);
    if (!descriptor) {
      return errorPayload({ status: 'error', message: `Unknown or not-permitted tool: ${name}` });
    }

    const { confirmationToken, ...rawInput } = args as Record<string, unknown> & {
      confirmationToken?: string;
    };

    const input = descriptor.operation.input.parse(rawInput);
    await permissions.authorize(descriptor.operation, input, { confirmationToken });

    return jsonResult(await descriptor.operation.run(input));
  } catch (error) {
    return errorResult(error);
  }
});

const sweeper = setInterval(() => sweepExpiredChallenges(), 60_000);
sweeper.unref();

async function shutdown(): Promise<void> {
  clearInterval(sweeper);
  await closeAllChallenges();
  closeDatabase();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

const transport = new StdioServerTransport();
await server.connect(transport);

log('server ready', {
  profile: permissions.profileName,
  readOnlyMode: permissions.readOnlyMode,
  funds: configuredFunds(),
});
