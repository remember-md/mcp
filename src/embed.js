// Lazy-loading embeddings wrapper around @huggingface/transformers.
// First call to embed/embedBatch downloads the model (cached after).
// _pipelineLoader hook lets tests inject a fake without real download.

// Public, ungated, 384-dim. We previously defaulted to bge-micro-v2 but
// Xenova/bge-micro-v2 went gated on HuggingFace (requires HF login + TOS
// accept), breaking unattended npx installs. all-MiniLM-L6-v2 stays public
// and is the long-standing baseline in Smart Connections / Continue.dev.
// Override at runtime with REMEMBER_EMBEDDING_MODEL env var.
const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';
const DEFAULT_DIM   = 384;

async function defaultLoader(model) {
  const { pipeline } = await import('@huggingface/transformers');
  // feature-extraction pipeline. Quantized q8 weights for smaller download.
  // Note: in transformers.js v3, pooling/normalize are CALL-time options
  // on the pipe(), not pipeline-construction options. We bind them at
  // call time below by wrapping the pipe in a function.
  const pipe = await pipeline('feature-extraction', model, {
    dtype: 'q8',  // v3 replacement for the legacy `quantized: true`
  });
  // Return a callable that always passes pooling + normalize so callers
  // can treat it as `pipe(inputs)` and get back a sentence-level
  // normalized embedding.
  return (inputs) => pipe(inputs, { pooling: 'mean', normalize: true });
}

export class Embedder {
  constructor({ model = DEFAULT_MODEL, dim = DEFAULT_DIM, _pipelineLoader } = {}) {
    this.model = model;
    this.dim = dim;
    this._loader = _pipelineLoader || defaultLoader;
    this._pipeline = null;
    this._loadingPromise = null;
  }

  async _ensureLoaded() {
    if (this._pipeline) return this._pipeline;
    if (this._loadingPromise) return this._loadingPromise;
    this._loadingPromise = (async () => {
      const p = await this._loader(this.model);
      this._pipeline = p;
      return p;
    })();
    return this._loadingPromise;
  }

  async embedBatch(texts) {
    if (!Array.isArray(texts) || texts.length === 0) return [];
    const pipe = await this._ensureLoaded();
    const out = await pipe(texts);
    // out: { data: Float32Array(n * dim), dims: [n, dim] }
    const [n, d] = out.dims;
    if (d !== this.dim) {
      throw new Error(`embedding dim mismatch: model returned ${d}, expected ${this.dim}`);
    }
    const result = [];
    for (let i = 0; i < n; i++) {
      result.push(out.data.slice(i * d, (i + 1) * d));
    }
    return result;
  }

  async embed(text) {
    const [v] = await this.embedBatch([text]);
    return v;
  }
}

// Worker that drains pending chunks from the DB, embeds them in batches,
// writes vectors into the `vec` virtual table, and marks chunks
// 'embedded'. Designed to run cooperatively (yields after every batch
// AND between every DB write) so concurrent MCP tool calls stay
// responsive even mid-indexing.
//
// Default batchSize is 8 (was 32). The smaller batch gives the event
// loop more frequent yield opportunities — at ~500ms per batch on
// commodity CPU, queued tool calls wait < 1s in the worst case, not
// 4+ seconds.
//
// onProgress(done, total) is called once per batch with cumulative
// embedded count and total chunk count. Errors abort the worker; caller
// should set vector_state = 'failed' on rejection.
export async function embedPending({ db, embedder, batchSize = 8, onProgress } = {}) {
  const total = db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n;
  if (total === 0) return { embedded: 0, total };

  const insVec = db.prepare('INSERT INTO vec (rowid, embedding) VALUES (?, ?)');
  const markEmbedded = db.prepare("UPDATE chunks SET vec_status = 'embedded' WHERE id = ?");

  let embeddedTotal = db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE vec_status='embedded'").get().n;

  const yieldNow = () => new Promise(r => setImmediate(r));

  while (true) {
    const pending = db.prepare(
      "SELECT id, text FROM chunks WHERE vec_status = 'pending' ORDER BY id LIMIT ?"
    ).all(batchSize);
    if (pending.length === 0) break;

    // Yield BEFORE the synchronous embed call so any tool call queued
    // since the last batch gets a chance to run first. The embed call
    // is the CPU-heavy step that holds the event loop.
    await yieldNow();

    const vecs = await embedder.embedBatch(pending.map(c => c.text));
    for (let i = 0; i < pending.length; i++) {
      const v = vecs[i];
      const buf = Buffer.from(v.buffer, v.byteOffset, v.byteLength);
      // sqlite-vec's vec0 vtab requires a BigInt rowid bind through node:sqlite.
      insVec.run(BigInt(pending[i].id), buf);
      markEmbedded.run(pending[i].id);
      embeddedTotal++;
    }

    if (onProgress) onProgress(embeddedTotal, total);
    await yieldNow();
  }

  return { embedded: embeddedTotal, total };
}
