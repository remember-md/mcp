import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { reindex } from '../src/reindex.js';

function setupBrain() {
  const root = mkdtempSync(join(tmpdir(), 'remember-mcp-reindex-'));
  mkdirSync(join(root, 'Notes'), { recursive: true });
  writeFileSync(
    join(root, 'Notes', 'a.md'),
    '# A\n\nbody A.\n\n[[Notes/b]] is linked.\n'
  );
  writeFileSync(
    join(root, 'Notes', 'b.md'),
    '# B\n\nbody B.\n'
  );
  return root;
}

test('reindex on fresh brain: ingests files, chunks, links — chunks left as pending', async () => {
  const root = setupBrain();
  const db = openDb(join(root, '.remember', 'index.db'));

  const result = await reindex({ db, root, model: 'Xenova/bge-micro-v2' });

  assert.equal(result.filesAdded, 2);
  assert.equal(result.filesUpdated, 0);
  assert.equal(result.filesDeleted, 0);

  const chunks = db.prepare('SELECT path, heading_path, vec_status FROM chunks ORDER BY path').all();
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.some(c => c.path === 'Notes/a.md'));
  assert.ok(chunks.some(c => c.path === 'Notes/b.md'));
  // No embedding happened in reindex — all chunks remain 'pending'.
  for (const c of chunks) assert.equal(c.vec_status, 'pending');

  // Vec table is empty (embedPending is the one that populates it).
  const vecRows = db.prepare('SELECT COUNT(*) AS n FROM vec').get().n;
  assert.equal(vecRows, 0);

  // Links extracted.
  const links = db.prepare('SELECT src, dst FROM links').all();
  assert.ok(links.some(l => l.src === 'Notes/a.md' && l.dst.includes('Notes/b')));

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('reindex incremental: unchanged files skipped (mtime match)', async () => {
  const root = setupBrain();
  const db = openDb(join(root, '.remember', 'index.db'));

  await reindex({ db, root, model: 'm' });
  const r2 = await reindex({ db, root, model: 'm' });

  assert.equal(r2.filesAdded, 0);
  assert.equal(r2.filesUpdated, 0);
  assert.equal(r2.filesDeleted, 0);

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('reindex incremental: edited file re-chunks', async () => {
  const root = setupBrain();
  const db = openDb(join(root, '.remember', 'index.db'));

  await reindex({ db, root, model: 'm' });

  // Modify one file with new content.
  writeFileSync(join(root, 'Notes', 'a.md'), '# A v2\n\nnew body.\n');
  const future = new Date(Date.now() + 5000);
  utimesSync(join(root, 'Notes', 'a.md'), future, future);

  const r2 = await reindex({ db, root, model: 'm' });
  assert.equal(r2.filesUpdated, 1);

  const aChunks = db.prepare("SELECT text FROM chunks WHERE path='Notes/a.md'").all();
  assert.ok(aChunks.some(c => /new body/.test(c.text)));
  assert.ok(!aChunks.some(c => /body A\./.test(c.text)));

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('reindex incremental: deleted file is removed', async () => {
  const root = setupBrain();
  const db = openDb(join(root, '.remember', 'index.db'));

  await reindex({ db, root, model: 'm' });
  unlinkSync(join(root, 'Notes', 'b.md'));

  const r2 = await reindex({ db, root, model: 'm' });
  assert.equal(r2.filesDeleted, 1);

  const bChunks = db.prepare("SELECT id FROM chunks WHERE path='Notes/b.md'").all();
  assert.equal(bChunks.length, 0);

  db.close();
  rmSync(root, { recursive: true, force: true });
});
