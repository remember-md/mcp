// SQLite handle with sqlite-vec extension and a versioned migration runner.
//
// Migrations:
//   - Each migration is `{ version, description, up(db) }` in MIGRATIONS.
//   - `openDb` applies any migration whose version > meta.schema_version,
//     in order, each inside its own transaction.
//   - SCHEMA_VERSION is the highest applied version after openDb returns.
//   - Add new versions by appending to MIGRATIONS — never edit a shipped
//     migration. If you need to undo something, write a new forward
//     migration (e.g. ALTER ADD COLUMN, then a later one to drop via
//     table rebuild).
//   - meta.schema_version is stored as text but compared as integer.

import { DatabaseSync } from 'node:sqlite';
import * as sqliteVec from 'sqlite-vec';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const MIGRATIONS = [
  {
    version: 1,
    description: 'initial schema (files, chunks, fts, vec, links)',
    up(db) {
      db.exec(`
        CREATE TABLE files (
          path  TEXT PRIMARY KEY,
          mtime INTEGER NOT NULL,
          hash  TEXT NOT NULL,
          model TEXT NOT NULL
        );

        CREATE TABLE chunks (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          path         TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
          heading_path TEXT NOT NULL,
          text         TEXT NOT NULL,
          vec_status   TEXT NOT NULL DEFAULT 'pending'
        );
        CREATE INDEX idx_chunks_path        ON chunks(path);
        CREATE INDEX idx_chunks_vec_status  ON chunks(vec_status);

        CREATE VIRTUAL TABLE fts USING fts5(text, content='chunks', content_rowid='id');

        CREATE VIRTUAL TABLE vec USING vec0(embedding FLOAT[384]);

        CREATE TABLE links (
          src TEXT NOT NULL,
          dst TEXT NOT NULL,
          PRIMARY KEY (src, dst)
        );
      `);
    },
  },
  // Append future migrations here. Examples (do not uncomment):
  //
  // {
  //   version: 2,
  //   description: 'add chunks.tags for hierarchical filtering',
  //   up(db) { db.exec("ALTER TABLE chunks ADD COLUMN tags TEXT"); },
  // },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

function ensureMetaTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

function readSchemaVersion(db) {
  const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
  if (!row) return 0;
  const n = Number.parseInt(row.value, 10);
  return Number.isFinite(n) ? n : 0;
}

function writeSchemaVersion(db, version) {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('schema_version', ?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(String(version));
}

export function openDb(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath, { allowExtension: true });
  sqliteVec.load(db);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  ensureMetaTable(db);
  const current = readSchemaVersion(db);

  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.exec('BEGIN');
    try {
      m.up(db);
      writeSchemaVersion(db, m.version);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      err.message = `migration ${m.version} (${m.description}) failed: ${err.message}`;
      throw err;
    }
  }

  return db;
}
