-- Every failure worth investigating later: failed model attempts, failed answers, undelivered alerts and emails.
CREATE TABLE incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  site TEXT NOT NULL,
  chat_id TEXT,
  kind TEXT NOT NULL,
  model TEXT,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX incidents_at ON incidents (at DESC);

-- Last time each throttled alert went out (e.g. "AI failed" at most once per 30 minutes).
CREATE TABLE alert_marks (
  key TEXT PRIMARY KEY,
  last_at INTEGER NOT NULL
);
