// Idempotent schema setup. Runs at boot (never at build time: xhostd has no DB during install.sh).
import { exec, query } from './db.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  sub           TEXT,
  name          TEXT,
  role          TEXT NOT NULL DEFAULT 'user',      -- user | admin
  status        TEXT NOT NULL DEFAULT 'pending',   -- active | pending | blocked
  token_limit   INTEGER,                           -- NULL = use the default from settings
  limit_period  TEXT,                              -- NULL = default; monthly | total
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT,
  doc_name    TEXT,
  analysis    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ                          -- soft delete keeps the usage log intact
);
CREATE INDEX IF NOT EXISTS conversations_user_updated ON conversations (user_id, updated_at DESC);

-- content = Claude API content blocks (replayed to the model); ui = what the browser renders.
CREATE TABLE IF NOT EXISTS messages (
  id               SERIAL PRIMARY KEY,
  conversation_id  UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role             TEXT NOT NULL,                  -- user | assistant
  content          JSONB NOT NULL,
  ui               JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_conversation ON messages (conversation_id, id);

CREATE TABLE IF NOT EXISTS usage_events (
  id                     SERIAL PRIMARY KEY,
  user_id                INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_email             TEXT NOT NULL,
  conversation_id        UUID,
  kind                   TEXT NOT NULL,            -- claude | tagit
  model                  TEXT,
  input_tokens           INTEGER NOT NULL DEFAULT 0,
  output_tokens          INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens      INTEGER NOT NULL DEFAULT 0,
  total_tokens           INTEGER NOT NULL DEFAULT 0,
  cost_usd               DOUBLE PRECISION NOT NULL DEFAULT 0,
  detail                 JSONB,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_events_user_created ON usage_events (user_id, created_at);
CREATE INDEX IF NOT EXISTS usage_events_created ON usage_events (created_at DESC);

-- One row per request a user sent (a chat turn, or a "more results" page). Usage events link to it,
-- so the admin query log can show who asked what, which searches ran, and what it cost.
CREATE TABLE IF NOT EXISTS turns (
  id               SERIAL PRIMARY KEY,
  user_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_email       TEXT NOT NULL,
  conversation_id  UUID,
  request_kind     TEXT NOT NULL,                  -- document | text | answers | more
  request_text     TEXT,
  file_name        TEXT,
  answers          JSONB,
  status           TEXT NOT NULL DEFAULT 'running', -- running | completed | awaiting_input | aborted | interrupted | error | quota_exceeded | refused | truncated | iteration_limit
  error            TEXT,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS turns_started ON turns (started_at DESC);
CREATE INDEX IF NOT EXISTS turns_user_started ON turns (user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS turns_conversation ON turns (conversation_id, id DESC);

ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS turn_id INTEGER;
CREATE INDEX IF NOT EXISTS usage_events_turn ON usage_events (turn_id);
`;

const DEFAULT_SETTINGS = {
  default_token_limit: 2000000,
  default_limit_period: 'monthly',
};

export async function migrate() {
  await exec(SCHEMA);
  // A request still "running" at boot belonged to a process that was restarted mid-turn.
  await query(
    `UPDATE turns SET status = 'interrupted', error = COALESCE(error, 'השרת הופעל מחדש במהלך העיבוד'), finished_at = now()
     WHERE status = 'running'`,
  );
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await query(
      'INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO NOTHING',
      [key, JSON.stringify(value)],
    );
  }
  console.log('[db] schema ready');
}
