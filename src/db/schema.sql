-- Studio24 RGS schema (pilot). Postgres 16.
-- Money is stored as BIGINT micro-units (1 unit = 1,000,000) so no float ever touches a balance.
-- Player identity: the RGS keys everything on a per-operator pseudonym (player_ref). The casino's own
-- player id (native_id) is needed to call its wallet, so it is kept only encrypted, on the session.

CREATE TABLE IF NOT EXISTS operators (
  id            TEXT PRIMARY KEY,                 -- e.g. 'simcasino'
  wallet_url    TEXT NOT NULL,                    -- base URL of the casino's seamless wallet
  hmac_secret   TEXT NOT NULL,                    -- X-Server-Authorization key (pilot: plain; production: secrets manager)
  pseudonym_key TEXT NOT NULL,                    -- per-operator key for player_ref = HMAC(key, native_id)
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id              UUID PRIMARY KEY,
  token_hash      TEXT NOT NULL UNIQUE,           -- sha256 of the bearer token given to the game client
  operator_id     TEXT NOT NULL REFERENCES operators(id),
  player_ref      TEXT NOT NULL,                  -- pseudonym, the only player key used elsewhere
  native_id_enc   TEXT NOT NULL,                  -- AES-256-GCM(native_id); needed for wallet calls only
  wallet_token    TEXT NOT NULL,                  -- token from the casino's /authenticate (sent as Authorization)
  game_id         TEXT NOT NULL,
  currency        TEXT NOT NULL,
  -- provably fair state for this player and game (commit-reveal)
  server_seed     TEXT NOT NULL,                  -- secret until rotated
  server_seed_hash TEXT NOT NULL,                 -- sha256(server_seed), shown before any bet
  client_seed     TEXT NOT NULL,
  nonce           BIGINT NOT NULL DEFAULT 0,      -- next nonce to use
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_player_idx ON sessions (operator_id, player_ref);

-- Revealed seeds (after rotation) so any past round can be verified.
CREATE TABLE IF NOT EXISTS revealed_seeds (
  server_seed_hash TEXT PRIMARY KEY,
  server_seed      TEXT NOT NULL,
  revealed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per round. State machine:
--   pending_debit -> debited -> settling -> settled
--   pending_debit -> rejected            (casino refused the bet: no money moved)
--   pending_debit -> cancelling -> cancelled   (debit outcome unknown: refund by /cancel)
CREATE TABLE IF NOT EXISTS rounds (
  id              UUID PRIMARY KEY,
  session_id      UUID NOT NULL REFERENCES sessions(id),
  request_id      TEXT NOT NULL,                  -- client's idempotency key
  operator_id     TEXT NOT NULL,
  player_ref      TEXT NOT NULL,
  game_id         TEXT NOT NULL,
  currency        TEXT NOT NULL,
  bet             BIGINT NOT NULL CHECK (bet > 0),
  win             BIGINT,                         -- set when the outcome is drawn
  params          JSONB NOT NULL,                 -- player's choices (e.g. Keno picks)
  outcome         JSONB,                          -- what was drawn
  server_seed_hash TEXT NOT NULL,
  client_seed     TEXT NOT NULL,
  nonce           BIGINT NOT NULL,
  state           TEXT NOT NULL,
  reject_code     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, request_id),
  UNIQUE (server_seed_hash, nonce)
);
CREATE INDEX IF NOT EXISTS rounds_state_idx ON rounds (state) WHERE state NOT IN ('settled', 'rejected', 'cancelled');

-- Every money movement we ask the casino for. Append-only in spirit: rows change state, never amount.
CREATE TABLE IF NOT EXISTS wallet_tx (
  id              UUID PRIMARY KEY,               -- the transactionId sent to the casino (same id on every retry)
  round_id        UUID NOT NULL REFERENCES rounds(id),
  kind            TEXT NOT NULL CHECK (kind IN ('withdraw', 'deposit', 'cancel')),
  amount          BIGINT NOT NULL CHECK (amount >= 0),
  state           TEXT NOT NULL CHECK (state IN ('pending', 'done', 'failed')),
  attempts        INT NOT NULL DEFAULT 0,
  last_error      TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  balance_after   BIGINT,                         -- casino balance reported on success
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  done_at         TIMESTAMPTZ,
  UNIQUE (round_id, kind)
);
CREATE INDEX IF NOT EXISTS wallet_tx_due_idx ON wallet_tx (next_attempt_at) WHERE state = 'pending';
