#!/usr/bin/env node
/**
 * @remember-md/mcp — Local MCP server for the Remember.md second brain.
 *
 * Exposes the brain (a folder of markdown) as a set of MCP tools any
 * MCP client (Claude Code, Cursor, Codex CLI, Claude.ai, ChatGPT, …)
 * can call: semantic search, retrieval, dashboard, and more.
 *
 * Brain location is read from REMEMBER_BRAIN_PATH env (fallback ~/remember).
 * Index lives at ${brain}/.remember/index.db (gitignored).
 *
 * Run via:   npx -y @remember-md/mcp
 */
'use strict';

const VERSION = '0.0.1';

// Skeleton — actual MCP wiring + search core land in subsequent commits.
async function main() {
  process.stderr.write(`@remember-md/mcp v${VERSION} — skeleton (not yet functional)\n`);
  process.stderr.write('Brain path: ' + (process.env.REMEMBER_BRAIN_PATH || '~/remember') + '\n');
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err.message}\n`);
  process.exit(1);
});
