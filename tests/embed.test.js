import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Embedder } from '../src/embed.js';

test('Embedder.dim returns 384 (declared without loading model)', () => {
  const e = new Embedder({ model: 'Xenova/bge-micro-v2' });
  assert.equal(e.dim, 384);
});

test('Embedder.embedBatch with mock returns one Float32Array(384) per input', async () => {
  const e = new Embedder({
    model: 'Xenova/bge-micro-v2',
    // Inject a fake pipeline so we don't actually download the model.
    _pipelineLoader: async () => async (inputs) => ({
      data: new Float32Array(inputs.length * 384).fill(0.5),
      dims: [inputs.length, 384],
    }),
  });

  const out = await e.embedBatch(['hello', 'world']);
  assert.equal(out.length, 2);
  for (const v of out) {
    assert.ok(v instanceof Float32Array);
    assert.equal(v.length, 384);
  }
});

test('Embedder.embed (single) returns one Float32Array(384)', async () => {
  const e = new Embedder({
    model: 'Xenova/bge-micro-v2',
    _pipelineLoader: async () => async (inputs) => ({
      data: new Float32Array(inputs.length * 384).fill(0.1),
      dims: [inputs.length, 384],
    }),
  });

  const v = await e.embed('a query');
  assert.ok(v instanceof Float32Array);
  assert.equal(v.length, 384);
});

test('embedPending: processes pending chunks, writes to vec table, marks embedded', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { openDb } = await import('../src/db.js');
  const { embedPending } = await import('../src/embed.js');

  const dir = mkdtempSync(join(tmpdir(), 'remember-mcp-embedp-'));
  const db = openDb(join(dir, 'index.db'));

  // Seed a file row + 3 pending chunks.
  db.prepare("INSERT INTO files (path, mtime, hash, model) VALUES ('x.md', 1, 'h', 'm')").run();
  for (const t of ['alpha text', 'beta text', 'gamma text']) {
    db.prepare("INSERT INTO chunks (path, heading_path, text) VALUES ('x.md', 'X', ?)").run(t);
  }

  const e = new Embedder({
    _pipelineLoader: async () => async (inputs) => ({
      data: new Float32Array(inputs.length * 384).fill(0.5),
      dims: [inputs.length, 384],
    }),
  });

  let progressCalls = 0;
  await embedPending({ db, embedder: e, batchSize: 2, onProgress: () => progressCalls++ });

  const pending = db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE vec_status='pending'").get().n;
  const embedded = db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE vec_status='embedded'").get().n;
  const vecRows = db.prepare("SELECT COUNT(*) AS n FROM vec").get().n;
  assert.equal(pending, 0);
  assert.equal(embedded, 3);
  assert.equal(vecRows, 3);
  assert.ok(progressCalls >= 1);

  db.close();
  rmSync(dir, { recursive: true, force: true });
});
