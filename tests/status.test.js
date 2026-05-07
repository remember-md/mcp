import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { getState, setState, ensureModelMatch, STATES } from '../src/status.js';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'remember-mcp-status-'));
  const dbPath = join(dir, 'index.db');
  const db = openDb(dbPath);
  return { db, dir };
}

test('getState returns not_started when meta empty', () => {
  const { db, dir } = freshDb();
  assert.equal(getState(db), STATES.NOT_STARTED);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('setState writes and getState reads', () => {
  const { db, dir } = freshDb();
  setState(db, STATES.EMBEDDING);
  assert.equal(getState(db), STATES.EMBEDDING);
  setState(db, STATES.READY);
  assert.equal(getState(db), STATES.READY);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('setState rejects unknown state', () => {
  const { db, dir } = freshDb();
  assert.throws(() => setState(db, 'bogus'), /unknown state/i);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('ensureModelMatch: first run sets model and returns false (no reset needed)', () => {
  const { db, dir } = freshDb();
  const reset = ensureModelMatch(db, 'Xenova/bge-micro-v2');
  assert.equal(reset, false);
  const stored = db.prepare("SELECT value FROM meta WHERE key='embedding_model'").get();
  assert.equal(stored.value, 'Xenova/bge-micro-v2');
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('ensureModelMatch: same model returns false', () => {
  const { db, dir } = freshDb();
  ensureModelMatch(db, 'Xenova/bge-micro-v2');
  const reset = ensureModelMatch(db, 'Xenova/bge-micro-v2');
  assert.equal(reset, false);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('ensureModelMatch: different model returns true and forces reset', () => {
  const { db, dir } = freshDb();
  ensureModelMatch(db, 'Xenova/bge-micro-v2');
  setState(db, STATES.READY);

  const reset = ensureModelMatch(db, 'Xenova/different-model');
  assert.equal(reset, true);

  // After reset, state must be not_started; model updated; vec wiped.
  assert.equal(getState(db), STATES.NOT_STARTED);
  const stored = db.prepare("SELECT value FROM meta WHERE key='embedding_model'").get();
  assert.equal(stored.value, 'Xenova/different-model');

  db.close();
  rmSync(dir, { recursive: true, force: true });
});
