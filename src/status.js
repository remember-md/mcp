// Index status state machine. Persisted in meta.vector_state. Single
// writer (the reindex worker), multiple readers (search.js, MCP entry).
// Also handles model-mismatch detection: if the user changes the
// configured embedding model, force a full vector rebuild.

export const STATES = Object.freeze({
  NOT_STARTED:        'not_started',
  MODEL_DOWNLOADING:  'model_downloading',
  EMBEDDING:          'embedding',
  READY:              'ready',
  FAILED:             'failed',
});

const VALID_STATES = new Set(Object.values(STATES));

export function getState(db) {
  const row = db.prepare("SELECT value FROM meta WHERE key='vector_state'").get();
  return row?.value || STATES.NOT_STARTED;
}

export function setState(db, state) {
  if (!VALID_STATES.has(state)) {
    throw new Error(`unknown state: ${state}`);
  }
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('vector_state', ?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(state);
}

export function setProgress(db, pct) {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('last_progress_pct', ?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(String(pct));
}

export function getProgress(db) {
  const row = db.prepare("SELECT value FROM meta WHERE key='last_progress_pct'").get();
  return row ? Number(row.value) : 0;
}

// Returns true if the configured model differs from the stored one and a
// full reset was performed. Otherwise returns false.
export function ensureModelMatch(db, configuredModel) {
  const row = db.prepare("SELECT value FROM meta WHERE key='embedding_model'").get();
  const stored = row?.value;

  if (!stored) {
    db.prepare("INSERT INTO meta (key, value) VALUES ('embedding_model', ?)").run(configuredModel);
    return false;
  }
  if (stored === configuredModel) return false;

  // Mismatch — wipe vec rows and chunks vec_status, reset state.
  db.exec('DELETE FROM vec');
  db.prepare("UPDATE chunks SET vec_status = 'pending'").run();
  setState(db, STATES.NOT_STARTED);
  db.prepare("UPDATE meta SET value = ? WHERE key = 'embedding_model'").run(configuredModel);
  return true;
}
