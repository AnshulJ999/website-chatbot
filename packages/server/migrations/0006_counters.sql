-- Per-day counters for abuse limits (messages left per visitor, emails to visitors per day).
CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, day TEXT NOT NULL, n INTEGER NOT NULL);
