// On-demand incremental reindexer. File walk + chunk + DB write only —
// NO embedding here. Embedding is `embedPending` in src/embed.js, run
// asynchronously by the MCP entry point so search results are available
// (BM25-first) the moment reindex returns.
//
// - Walks ${root}/**/*.md (excluding .remember, node_modules, .git)
// - For each file: compares (mtime, hash) against files table
// - Mismatch → re-chunks, replaces rows, marks chunks vec_status='pending'
// - Files no longer present → deletes their rows + FTS/vec entries
// - Returns { filesAdded, filesUpdated, filesDeleted }

import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import fg from 'fast-glob';
import { chunkMarkdown } from './chunk.js';

const WIKILINK_RE = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g;

function extractLinks(body) {
  const out = new Set();
  for (const m of body.matchAll(WIKILINK_RE)) {
    out.add(m[1].trim());
  }
  return [...out];
}

async function listMarkdown(root) {
  return fg('**/*.md', {
    cwd: root,
    ignore: ['.remember/**', 'node_modules/**', '.git/**'],
    dot: false,
  });
}

function readFilesRow(db, path) {
  return db.prepare('SELECT mtime, hash FROM files WHERE path = ?').get(path);
}

function deleteFileRows(db, path) {
  db.prepare('DELETE FROM links WHERE src = ?').run(path);
  // chunks have ON DELETE CASCADE → removing files row clears chunks.
  // FTS and vec entries: explicit cleanup to avoid orphans.
  const chunkIds = db.prepare('SELECT id FROM chunks WHERE path = ?').all(path).map(r => r.id);
  for (const id of chunkIds) {
    db.prepare('DELETE FROM fts WHERE rowid = ?').run(id);
    db.prepare('DELETE FROM vec WHERE rowid = ?').run(BigInt(id));
  }
  db.prepare('DELETE FROM files WHERE path = ?').run(path);
}

function insertChunks(db, path, chunks) {
  const ins = db.prepare(
    "INSERT INTO chunks (path, heading_path, text, vec_status) VALUES (?, ?, ?, 'pending')"
  );
  const insFts = db.prepare("INSERT INTO fts (rowid, text) VALUES (?, ?)");
  for (const c of chunks) {
    const info = ins.run(c.path, c.heading_path, c.text);
    const id = Number(info.lastInsertRowid);
    insFts.run(id, c.text);
  }
}

function insertLinks(db, src, dsts) {
  db.prepare('DELETE FROM links WHERE src = ?').run(src);
  const ins = db.prepare('INSERT OR IGNORE INTO links (src, dst) VALUES (?, ?)');
  for (const dst of dsts) ins.run(src, dst);
}

export async function reindex({ db, root, model }) {
  const stats = { filesAdded: 0, filesUpdated: 0, filesDeleted: 0 };

  const present = new Set(await listMarkdown(root));

  // 1. Detect deletions.
  const known = db.prepare('SELECT path FROM files').all().map(r => r.path);
  for (const p of known) {
    if (!present.has(p)) {
      deleteFileRows(db, p);
      stats.filesDeleted++;
    }
  }

  // 2. Walk present files, ingest changed.
  for (const rel of present) {
    const abs = resolve(root, rel);
    const st = await stat(abs);
    const mtime = Math.floor(st.mtimeMs);

    const prev = readFilesRow(db, rel);
    if (prev && prev.mtime === mtime) continue; // mtime cheap pre-filter

    const body = await readFile(abs, 'utf8');
    const hash = createHash('sha1').update(body).digest('hex');

    if (prev && prev.hash === hash) {
      // mtime touched but content unchanged → just bump mtime.
      db.prepare('UPDATE files SET mtime = ? WHERE path = ?').run(mtime, rel);
      continue;
    }

    // Real change (or new file). Wipe old chunks/fts/vec/links for this path.
    deleteFileRows(db, rel);

    // files row must exist before chunks (FK reference).
    db.prepare(
      "INSERT INTO files (path, mtime, hash, model) VALUES (?, ?, ?, ?)"
    ).run(rel, mtime, hash, model);

    const chunks = chunkMarkdown({ path: rel, body });
    insertChunks(db, rel, chunks);
    insertLinks(db, rel, extractLinks(body));

    if (prev) stats.filesUpdated++;
    else      stats.filesAdded++;
  }

  return stats;
}
