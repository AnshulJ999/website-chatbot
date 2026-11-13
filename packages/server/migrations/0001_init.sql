CREATE TABLE sites (
  key TEXT PRIMARY KEY,
  config TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE visitors (
  id TEXT PRIMARY KEY,
  site TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  name TEXT,
  email TEXT,
  country TEXT,
  city TEXT,
  device TEXT,
  msg_day TEXT,
  msg_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE chats (
  id TEXT PRIMARY KEY,
  site TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  mode TEXT NOT NULL DEFAULT 'ai',
  wants_owner INTEGER NOT NULL DEFAULT 0,
  visitor_online INTEGER NOT NULL DEFAULT 0,
  message_count INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  model TEXT,
  preview TEXT NOT NULL DEFAULT '',
  page TEXT,
  referrer TEXT,
  unread INTEGER NOT NULL DEFAULT 0,
  agent_id TEXT,
  agent_archived INTEGER NOT NULL DEFAULT 0,
  thumbs_up INTEGER NOT NULL DEFAULT 0,
  thumbs_down INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX chats_updated ON chats (updated_at DESC);
CREATE INDEX chats_visitor ON chats (visitor_id, updated_at DESC);

CREATE TABLE enquiries (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  site TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  created_at INTEGER NOT NULL
);
CREATE INDEX enquiries_created ON enquiries (created_at DESC);

CREATE TABLE spend_daily (
  day TEXT NOT NULL,
  site TEXT NOT NULL,
  usd REAL NOT NULL DEFAULT 0,
  turns INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, site)
);

CREATE TABLE model_health (
  model TEXT PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0,
  last_failure INTEGER,
  cooldown_until INTEGER
);
