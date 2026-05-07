import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, MIGRATIONS, SCHEMA_VERSION } from '../src/db.js';

function freshDir() {
  return mkdtempSync(join(tmpdir(), 'remember-mcp-db-'));
}

test('openDb applies all migrations and reports SCHEMA_VERSION', () => {
  const dir = freshDir();
  const db = openDb(join(dir, 'index.db'));

  const vec = db.prepare('SELECT vec_version() AS v').get();
  assert.match(vec.v, /^v\d+\.\d+/);

  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all().map(r => r.name);
  for (const t of ['files', 'chunks', 'links', 'meta']) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }

  const all = db.prepare("SELECT name FROM sqlite_master ORDER BY name").all().map(r => r.name);
  assert.ok(all.includes('fts'), 'missing fts virtual table');
  assert.ok(all.includes('vec'), 'missing vec virtual table');

  const sv = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
  assert.equal(Number.parseInt(sv.value, 10), SCHEMA_VERSION);

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('openDb is idempotent — re-opening at the same version is a no-op', () => {
  const dir = freshDir();
  const dbPath = join(dir, 'index.db');

  const db1 = openDb(dbPath);
  db1.close();

  const db2 = openDb(dbPath);
  const sv = db2.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
  assert.equal(Number.parseInt(sv.value, 10), SCHEMA_VERSION);
  db2.close();

  rmSync(dir, { recursive: true, force: true });
});

test('MIGRATIONS list is sorted by version asc with no duplicates', () => {
  const versions = MIGRATIONS.map(m => m.version);
  const sorted = [...versions].sort((a, b) => a - b);
  assert.deepEqual(versions, sorted, 'MIGRATIONS must be sorted by version asc');
  assert.equal(new Set(versions).size, versions.length, 'duplicate migration versions');
});

test('openDb skips already-applied migrations on subsequent opens', (t) => {
  // Spy: count how many times the v1 migration runs across two openDb()
  // calls on the same DB. Should be exactly 1 (first call), not 2.
  const dir = freshDir();
  const dbPath = join(dir, 'index.db');

  const v1 = MIGRATIONS.find(m => m.version === 1);
  const originalUp = v1.up;
  let calls = 0;
  v1.up = (db) => { calls++; originalUp(db); };

  try {
    const db1 = openDb(dbPath);
    db1.close();
    const db2 = openDb(dbPath);
    db2.close();
    assert.equal(calls, 1, 'v1 migration should only run once across two opens');
  } finally {
    v1.up = originalUp;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migration failure rolls back and re-throws with a useful message', () => {
  // Inject a bad migration directly into the array for this test only.
  // We append; existing v1 runs cleanly first, then v2 fails, then we
  // assert state was rolled back.
  const dir = freshDir();
  const dbPath = join(dir, 'index.db');

  // Seed v1 first via normal path.
  const db1 = openDb(dbPath);
  db1.close();

  MIGRATIONS.push({
    version: 999,
    description: 'broken migration for test',
    up(db) { db.exec('CREATE TABLE invalid syntax here'); },
  });
  try {
    assert.throws(
      () => openDb(dbPath),
      /migration 999 \(broken migration for test\) failed/,
    );
    // Verify the broken migration's partial DDL was rolled back: there
    // should be NO 'invalid' table.
    const db2 = new DatabaseSync(dbPath);
    const t = db2.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='invalid'"
    ).get();
    assert.equal(t, undefined);
    db2.close();
  } finally {
    MIGRATIONS.pop();
    rmSync(dir, { recursive: true, force: true });
  }
});
