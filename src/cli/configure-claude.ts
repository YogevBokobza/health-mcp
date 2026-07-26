import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stdout } from 'node:process';

/** Where Claude Desktop keeps its MCP server list, per platform. */
export function claudeConfigPath(): string {
  const home = os.homedir();

  switch (process.platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    case 'win32':
      return path.join(
        process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'),
        'Claude',
        'claude_desktop_config.json',
      );
    default:
      return path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
  }
}

/** Absolute path to the built server entry point. */
function serverEntryPoint(): string {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'mcp', 'server.js');
}

/**
 * Registers this server with Claude Desktop, preserving whatever else is configured.
 *
 * The config file is read, merged and rewritten rather than replaced — clobbering
 * someone's other MCP servers to add one would be a poor trade.
 *
 * The encryption key is deliberately left blank: writing it here would put the key that
 * protects the database into a plaintext file next to it, which defeats encrypting it
 * at all.
 */
export function writeClaudeConfig(): void {
  const configPath = claudeConfigPath();
  const entry = serverEntryPoint();

  let config: { mcpServers?: Record<string, unknown> } = {};

  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
      throw new Error(
        `${configPath} exists but is not valid JSON. Fix or move it, then run this again.`,
      );
    }
  }

  config.mcpServers = {
    ...config.mcpServers,
    'health-mcp': {
      command: 'node',
      args: [entry],
      env: {
        HEALTH_MCP_KEY: '',
        HEALTH_MCP_MODE: 'readonly',
      },
    },
  };

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

  stdout.write(
    `Added health-mcp to ${configPath}\n\n` +
      `Now set HEALTH_MCP_KEY in that file to your database key, and restart Claude Desktop.\n` +
      `It was left blank on purpose — this tool will not write your key to a plaintext file.\n`,
  );
}
