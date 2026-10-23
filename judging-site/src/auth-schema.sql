CREATE TABLE web_sessions (id TEXT PRIMARY KEY NOT NULL, csrf TEXT NOT NULL,
mode TEXT NOT NULL CHECK (mode IN ('fixture','live')), expires INTEGER NOT NULL,
attempts INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0);
CREATE INDEX web_sessions_expiry ON web_sessions(expires);
CREATE TABLE web_unlock_budget (bucket TEXT PRIMARY KEY NOT NULL,
window_start INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
CREATE INDEX web_unlock_budget_expiry ON web_unlock_budget(window_start);
