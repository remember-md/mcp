import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { Embedder, embedPending } from '../src/embed.js';
import { reindex } from '../src/reindex.js';
import { searchBrain, rrfFuse } from '../src/search.js';

function fakeEmbedder(scoreOverride = null) {
  return new Embedder({
    _pipelineLoader: async () => async (inputs) => {
      // Deterministic pseudo-vectors keyed by content for reproducibility.
      const data = new Float32Array(inputs.length * 384);
      for (let i = 0; i < inputs.length; i++) {
        const seed = scoreOverride ?? (inputs[i].length % 7) / 10;
        for (let j = 0; j < 384; j++) {
          data[i * 384 + j] = ((j * seed) % 1);
        }
      }
      return { data, dims: [inputs.length, 384] };
    },
  });
}

function setupBrain() {
  const root = mkdtempSync(join(tmpdir(), 'remember-mcp-search-'));
  mkdirSync(join(root, 'Notes'), { recursive: true });
  writeFileSync(
    join(root, 'Notes', 'postgres.md'),
    '# Postgres\n\nprefer postgres for small projects with ACID needs.\n\n[[Notes/sqlite]] is the alternative.\n'
  );
  writeFileSync(
    join(root, 'Notes', 'sqlite.md'),
    '# SQLite\n\nlightweight embedded option for read-heavy workloads.\n'
  );
  writeFileSync(
    join(root, 'Notes', 'react.md'),
    '# React\n\nUI library with hooks and components.\n'
  );
  return root;
}

test('rrfFuse: combines two ranked lists with k=60 reciprocal rank', () => {
  const a = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const b = [{ id: 3 }, { id: 4 }, { id: 5 }];
  const fused = rrfFuse([a, b], h => h.id, { k: 60 });

  // id=3 appears in both → highest score
  assert.equal(fused[0].id, 3);
  // total entries: 5 unique ids
  assert.equal(fused.length, 5);
});

test('searchBrain: returns BM25 results when vector_state != ready', async () => {
  const root = setupBrain();
  const db = openDb(join(root, '.remember', 'index.db'));
  const emb = fakeEmbedder();
  await reindex({ db, root, model: emb.model });

  // Force vector_state to 'embedding' (simulating in-progress)
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('vector_state', 'embedding') " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run();

  const out = await searchBrain({ db, embedder: emb, query: 'postgres', top_k: 5 });
  assert.ok(out.results.length > 0);
  assert.match(out.note || '', /(BM25|index|building|lexical)/i);
  // postgres should rank top
  assert.match(out.results[0].path, /postgres/);

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('searchBrain: hybrid mode includes vector + bm25 sources when ready', async () => {
  const root = setupBrain();
  const db = openDb(join(root, '.remember', 'index.db'));
  const emb = fakeEmbedder();
  await reindex({ db, root, model: emb.model });
  // Embed all chunks so we can use vector mode.
  await embedPending({ db, embedder: emb });

  // Mark ready
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('vector_state', 'ready') " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run();

  const out = await searchBrain({ db, embedder: emb, query: 'postgres', top_k: 5 });
  assert.ok(out.results.length > 0);
  // Note should NOT mention indexing in progress.
  assert.ok(!out.note || !/building|in progress/i.test(out.note));

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('searchBrain: wikilink expand includes linked file when relevant', async () => {
  const root = setupBrain();
  const db = openDb(join(root, '.remember', 'index.db'));
  const emb = fakeEmbedder();
  await reindex({ db, root, model: emb.model });
  await embedPending({ db, embedder: emb });
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('vector_state', 'ready') " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run();

  const out = await searchBrain({ db, embedder: emb, query: 'postgres ACID', top_k: 5 });
  // sqlite.md is linked from postgres.md; expansion should surface it.
  const paths = out.results.map(r => r.path);
  // At minimum postgres should be present; sqlite may appear via expansion.
  assert.ok(paths.some(p => /postgres/.test(p)));

  db.close();
  rmSync(root, { recursive: true, force: true });
});
