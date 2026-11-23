-- D1 schema for the Publisher V2 Worker (docs/v2/research/cloudflare-adapter.md §3.2).
-- One row per alias; every generation is also appended to alias_history in the same
-- D1 batch (a transaction), so an alias never moves without its history.
-- No statement anywhere in the Worker deletes a row.
CREATE TABLE IF NOT EXISTS alias (
  name TEXT PRIMARY KEY,
  content_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  op_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS alias_history (
  name TEXT NOT NULL,
  generation INTEGER NOT NULL,
  content_id TEXT NOT NULL,
  op_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (name, generation)
);
