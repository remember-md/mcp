#!/usr/bin/env node
// @remember-md/mcp — local MCP server exposing the Remember.md second
// brain (folder of markdown) as a `search_brain` tool. Stdio transport.
//
// Brain path: env REMEMBER_BRAIN_PATH (fallback ~/remember).
// Index:      ${brain}/.remember/index.db (gitignored).
// Lifecycle:
//   1. Resolve brain path; abort if missing.
//   2. Open DB, ensure model match, kick off background worker if vector
//      not ready.
//   3. Speak MCP. On `search_brain` tool calls, run incremental reindex
//      then delegate to searchBrain().

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';

import { openDb } from './db.js';
import { Embedder, embedPending } from './embed.js';
import { reindex } from './reindex.js';
import { searchBrain } from './search.js';
import { getState, setState, ensureModelMatch, setProgress, STATES } from './status.js';

const VERSION = '0.1.4';
const DEFAULT_MODEL = process.env.REMEMBER_EMBEDDING_MODEL || 'Xenova/all-MiniLM-L6-v2';

function resolveBrain() {
  const raw = process.env.REMEMBER_BRAIN_PATH || '~/remember';
  const expanded = raw.startsWith('~') ? join(homedir(), raw.slice(1)) : raw;
  return resolve(expanded);
}

function fail(msg) {
  process.stderr.write(`@remember-md/mcp: ${msg}\n`);
  process.exit(1);
}

// Background worker: ensures every chunk gets an embedding. Runs
// cooperatively (yields between batches) so concurrent search_brain
// calls aren't blocked. Updates state machine + progress meta.
async function backgroundIndex(db, embedder) {
  try {
    setState(db, STATES.MODEL_DOWNLOADING);
    await embedder.embed('warmup');           // forces model download

    setState(db, STATES.EMBEDDING);
    const total = db.prepare("SELECT COUNT(*) AS n FROM chunks").get().n;

    await embedPending({
      db,
      embedder,
      // batchSize uses embed.js default (8) — smaller batch keeps the
      // event loop responsive for concurrent MCP tool calls during
      // indexing. Don't override unless you have a reason.
      onProgress: (done) => {
        if (total > 0) setProgress(db, Math.floor((done / total) * 100));
      },
    });

    setState(db, STATES.READY);
    setProgress(db, 100);
    process.stderr.write('@remember-md/mcp: vector index ready\n');
  } catch (err) {
    setState(db, STATES.FAILED);
    process.stderr.write(`@remember-md/mcp: vector indexing failed: ${err.message}\n`);
  }
}

async function main() {
  const brain = resolveBrain();
  if (!existsSync(brain)) {
    fail(`brain path "${brain}" does not exist. Set REMEMBER_BRAIN_PATH or run /remember:init.`);
  }

  const dbPath = join(brain, '.remember', 'index.db');
  let db;
  try {
    db = openDb(dbPath);
  } catch (err) {
    fail(`failed to open index: ${err.message}`);
  }

  const embedder = new Embedder({ model: DEFAULT_MODEL });
  ensureModelMatch(db, embedder.model);

  // Initial reindex (fast — mtime+hash diff + chunk/DB only, no embeds).
  // This makes BM25/FTS5 results available immediately even on first run.
  try {
    await reindex({ db, root: brain, model: embedder.model });
  } catch (err) {
    process.stderr.write(`@remember-md/mcp: initial reindex failed: ${err.message}\n`);
  }

  // Always kick off the background indexer if anything is pending. This
  // is non-blocking — the MCP server proceeds to handshake immediately
  // and BM25 queries work while embeddings build.
  const pending = db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE vec_status='pending'").get().n;
  if (pending > 0) {
    backgroundIndex(db, embedder).catch(() => {});
  } else if (getState(db) === STATES.NOT_STARTED) {
    // Brain is empty (no chunks yet) — mark ready so search returns
    // empty cleanly with the right note.
    setState(db, STATES.READY);
  }

  // MCP server
  const server = new Server(
    { name: '@remember-md/mcp', version: VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'search_brain',
        description: [
          "Search the user's markdown second brain (Notes, People, Projects, Journal, Areas).",
          'Returns ranked chunks with citations. Hybrid retrieval: BM25 (lexical) + vector (semantic) + 1-hop wikilink expansion, fused with reciprocal rank.',
          '',
          'HOW TO QUERY EFFECTIVELY:',
          '- Pass a 3–7 word topical phrase, NOT the user\'s full question.',
          '- Strip stopwords and question words. Keep nouns + concepts + proper names.',
          '- Match the brain\'s language. Technical notes are usually English even when the user writes Romanian. Personal/strategic notes are often Romanian. When in doubt, try both languages on separate calls.',
          '- Phrase as a declarative noun-phrase (how content is written), not as an interrogative.',
          '',
          'GOOD vs BAD examples:',
          '  user: "what do I think about postgres for small projects"',
          '    bad:  "what do I think about postgres for small projects"',
          '    good: "postgres small projects preferences"',
          '  user: "who works on dollie"',
          '    bad:  "who works on dollie"',
          '    good: "dollie project people contributors"',
          '  user: "ce cred despre lucrul în paralel pe proiecte"',
          '    bad:  "ce cred despre lucrul în paralel"',
          '    good: "multiple parallel projects orchestration" (English — matches technical notes)',
          '  user: "ce decizii am luat în martie"',
          '    good: "decisions march 2026" OR "decizii martie 2026" (try both)',
          '',
          'RESPONSE FIELDS:',
          '- results[].source: "vector+bm25" (strongest signal — both methods agreed), "vector" (semantic only), "bm25" (lexical only), "wikilink-expand" (related via [[link]])',
          '- results[].score: higher is better; >0.025 usually indicates a strong hit',
          '- note: present when vector index is building or failed — results are BM25-only in those cases',
          '',
          'MULTI-CALL STRATEGY:',
          '- If top result score < 0.020 OR no result obviously matches the user intent, call again with a different phrasing (alternative keywords, alternative language) before concluding "not found".',
          '- For broad topics, prefer 2 narrow calls over 1 wide call.',
          '',
          'PERSONA NOTE: the user\'s Persona.md is already injected at session start. Do not query for things contained in Persona itself (Mission, Directives, recent Evidence Log entries) — you already have them.',
        ].join('\n'),
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              minLength: 1,
              description: 'Topical phrase, 3–7 words. Nouns + concepts + names. NOT a full question.',
            },
            top_k: {
              type: 'integer',
              default: 10,
              minimum: 1,
              maximum: 50,
              description: 'Number of results to return. 5–10 for focused queries, 15–25 for broad surveys.',
            },
          },
          required: ['query'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== 'search_brain') {
      throw new Error(`unknown tool: ${req.params.name}`);
    }
    const { query, top_k = 10 } = req.params.arguments || {};
    // Cheap incremental reindex on every call (mtime-only path is ~50-200ms).
    const stats = await reindex({ db, root: brain, model: embedder.model });
    // If reindex added/updated files, those new chunks are 'pending'. Kick
    // the background indexer so they get embedded eventually. (No-op if
    // already running; the worker only embeds 'pending' rows.)
    if (stats.filesAdded + stats.filesUpdated > 0 && getState(db) === STATES.READY) {
      setState(db, STATES.EMBEDDING);
      backgroundIndex(db, embedder).catch(() => {});
    }
    const out = await searchBrain({ db, embedder, query, top_k });
    return {
      content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(`@remember-md/mcp v${VERSION} ready (brain: ${brain})\n`);
}

main().catch((err) => fail(err.stack || err.message));
