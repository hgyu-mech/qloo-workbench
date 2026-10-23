CREATE TABLE web_sessions (id TEXT PRIMARY KEY NOT NULL, csrf TEXT NOT NULL,
mode TEXT NOT NULL CHECK (mode IN ('fixture','live')), expires INTEGER NOT NULL,
attempts INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0);
--> statement-breakpoint
CREATE INDEX web_sessions_expiry ON web_sessions(expires);
--> statement-breakpoint
CREATE TABLE web_unlock_budget (bucket TEXT PRIMARY KEY NOT NULL,
window_start INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
--> statement-breakpoint
CREATE INDEX web_unlock_budget_expiry ON web_unlock_budget(window_start);
--> statement-breakpoint
-- Apply explicitly as a migration. The request handler never executes DDL.
PRAGMA foreign_keys = ON;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS qloo_policies (
  policy_id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  max_http_attempts INTEGER NOT NULL CHECK (max_http_attempts > 0),
  used INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0 AND used <= max_http_attempts),
  stopped INTEGER NOT NULL DEFAULT 0 CHECK (stopped IN (0, 1)),
  stop_code TEXT,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS qloo_sessions (
  session_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('fixture', 'live')),
  expires_at INTEGER NOT NULL,
  stopped INTEGER NOT NULL DEFAULT 0 CHECK (stopped IN (0, 1)),
  stop_code TEXT,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS qloo_resolutions (
  resolution_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES qloo_sessions(session_id) ON DELETE CASCADE,
  candidates_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  chosen_tag TEXT,
  receipt TEXT UNIQUE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS qloo_resolutions_session ON qloo_resolutions(session_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS qloo_receipts (
  receipt TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES qloo_sessions(session_id) ON DELETE CASCADE,
  resolution_id TEXT NOT NULL UNIQUE REFERENCES qloo_resolutions(resolution_id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL,
  tag_name TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('issued', 'consumed', 'complete', 'failed')),
  request_target TEXT,
  request_limit INTEGER,
  result_json TEXT
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS qloo_receipts_session ON qloo_receipts(session_id);
--> statement-breakpoint
-- Reservation is charged before fetch, including failed or abandoned requests.
-- It contains fixed endpoint/status/code only: no key, query, or raw body.
CREATE TABLE IF NOT EXISTS qloo_attempts (
  reservation_id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL REFERENCES qloo_policies(policy_id),
  session_id TEXT NOT NULL REFERENCES qloo_sessions(session_id),
  endpoint TEXT NOT NULL CHECK (endpoint IN ('/v2/tags', '/v2/insights')),
  created_at INTEGER NOT NULL,
  status INTEGER,
  stop_code TEXT
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS qloo_attempts_policy ON qloo_attempts(policy_id);
