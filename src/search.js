// Hybrid retrieval: vector top-K + BM25 top-K + RRF fuse + 1-hop wikilink
// expansion. Falls back to BM25-only when vector_state != 'ready'.
//
// Output shape:
//   { results: [{path, heading_path, text, score, source}], stats, note }

import { getState, getProgress, STATES } from './status.js';

const RRF_K = 60;
const FETCH_K = 20;
const EXPAND_BUDGET = 5;
const EXPAND_PENALTY = 0.7;

export function rrfFuse(rankedLists, idFn, { k = RRF_K } = {}) {
  const scores = new Map();
  const items = new Map();
  for (const list of rankedLists) {
    list.forEach((item, rank) => {
      const id = idFn(item);
      const incr = 1 / (k + rank);
      scores.set(id, (scores.get(id) || 0) + incr);
      if (!items.has(id)) items.set(id, item);
    });
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, score]) => ({ ...items.get(id), score }));
}

function bm25Top(db, query, top_k) {
  return db.prepare(`
    SELECT chunks.id, chunks.path, chunks.heading_path, chunks.text,
           bm25(fts) AS bm25_score
    FROM fts JOIN chunks ON fts.rowid = chunks.id
    WHERE fts MATCH ?
    ORDER BY bm25_score
    LIMIT ?
  `).all(query, top_k);
}

function vectorTop(db, qVecBuffer, top_k) {
  return db.prepare(`
    SELECT chunks.id, chunks.path, chunks.heading_path, chunks.text,
           vec_distance_cosine(vec.embedding, ?) AS dist
    FROM vec JOIN chunks ON vec.rowid = chunks.id
    WHERE chunks.vec_status = 'embedded'
    ORDER BY dist
    LIMIT ?
  `).all(qVecBuffer, top_k);
}

function expandByWikilinks(db, topResults, budget) {
  const seen = new Set(topResults.map(r => r.path));
  const out = [];
  for (const r of topResults.slice(0, 3)) {
    if (out.length >= budget) break;
    const links = db.prepare('SELECT dst FROM links WHERE src = ?').all(r.path);
    for (const { dst } of links) {
      if (out.length >= budget) break;
      // Resolve dst to a file path that exists in our chunks
      const candidates = db.prepare(
        "SELECT path FROM files WHERE path = ? OR path LIKE ?"
      ).all(dst.endsWith('.md') ? dst : dst + '.md', `%/${dst}.md`);
      for (const { path } of candidates) {
        if (seen.has(path) || out.length >= budget) continue;
        const chunk = db.prepare(`
          SELECT chunks.id, chunks.path, chunks.heading_path, chunks.text
          FROM chunks WHERE path = ? LIMIT 1
        `).get(path);
        if (chunk) {
          out.push({ ...chunk, score: r.score * EXPAND_PENALTY, source: 'wikilink-expand' });
          seen.add(path);
        }
      }
    }
  }
  return out;
}

export async function searchBrain({ db, embedder, query, top_k = 10 }) {
  if (!query || !query.trim()) {
    throw new Error('query must be non-empty');
  }
  const state = getState(db);
  const totalChunks = db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n;

  const bm25 = bm25Top(db, query, FETCH_K).map(r => ({
    id: r.id, path: r.path, heading_path: r.heading_path, text: r.text,
    source: 'bm25',
  }));

  let fused;
  let note = null;
  if (state === STATES.READY) {
    const qVec = await embedder.embed(query);
    const buf = Buffer.from(qVec.buffer, qVec.byteOffset, qVec.byteLength);
    const vec = vectorTop(db, buf, FETCH_K).map(r => ({
      id: r.id, path: r.path, heading_path: r.heading_path, text: r.text,
      source: 'vector',
    }));
    fused = rrfFuse([vec, bm25], h => h.id);
    // Mark which sources contributed.
    const vecIds = new Set(vec.map(h => h.id));
    const bmIds  = new Set(bm25.map(h => h.id));
    for (const f of fused) {
      const inV = vecIds.has(f.id), inB = bmIds.has(f.id);
      f.source = inV && inB ? 'vector+bm25' : (inV ? 'vector' : 'bm25');
    }
  } else {
    fused = bm25.map((h, i) => ({ ...h, score: 1 / (RRF_K + i) }));
    if (state === STATES.EMBEDDING || state === STATES.MODEL_DOWNLOADING) {
      note = `Vector index building (${getProgress(db)}%); BM25 results only.`;
    } else if (state === STATES.FAILED) {
      note = 'Vector index unavailable; BM25 results only.';
    } else if (state === STATES.NOT_STARTED) {
      note = 'Vector index not built yet; BM25 results only.';
    }
  }

  const top = fused.slice(0, top_k);
  const expanded = expandByWikilinks(db, top, EXPAND_BUDGET);

  const results = [...top, ...expanded].map(r => ({
    path: r.path,
    heading_path: r.heading_path,
    text: r.text,
    score: Number(r.score?.toFixed?.(4) ?? r.score),
    source: r.source,
  }));

  return {
    results,
    stats: { total_chunks: totalChunks, vector_state: state },
    note,
  };
}
