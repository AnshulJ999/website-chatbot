-- One row per AI answer: how long it took and how it ended.
CREATE TABLE answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  site TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  model TEXT,
  -- ok | partial (stopped early, words kept) | form (no model answered) | owner (taken over) | failed
  outcome TEXT NOT NULL,
  first_piece_ms INTEGER,
  first_word_ms INTEGER,
  total_ms INTEGER NOT NULL,
  lookups INTEGER NOT NULL DEFAULT 0,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL
);
CREATE INDEX answers_at ON answers (at DESC);
