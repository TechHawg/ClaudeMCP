-- ═══════════════════════════════════════════════════════════════════════════
-- Betting MCP Server — PostgreSQL Schema
-- Fully idempotent: safe to run multiple times.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Bets table: one row per logged bet ────────────────────────────────────
CREATE TABLE IF NOT EXISTS bets (
  id              SERIAL PRIMARY KEY,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sport           VARCHAR(50)  NOT NULL,
  league          VARCHAR(50),
  game            VARCHAR(200) NOT NULL,
  game_date       DATE,
  bet_type        VARCHAR(50)  NOT NULL,  -- moneyline, spread, total, prop, parlay
  market          VARCHAR(50),            -- h2h, spreads, totals, player_points, etc.
  player_name     VARCHAR(200),           -- nullable; for props only
  side            VARCHAR(100) NOT NULL,  -- e.g. "Chiefs -3.5", "Over 47.5", "LeBron Over 25.5 pts"
  line            NUMERIC(10,2),          -- the spread or total number
  odds            INTEGER NOT NULL,       -- American odds e.g. -110, +150
  stake           NUMERIC(12,2) NOT NULL,
  book            VARCHAR(100) NOT NULL,
  edge_pct        NUMERIC(6,3),           -- estimated edge in %
  sharp_pct       NUMERIC(5,1),           -- sharp money % on this side
  public_pct      NUMERIC(5,1),           -- public betting % on this side
  kelly_fraction  NUMERIC(4,2),           -- e.g. 0.25 for quarter Kelly
  confidence_score NUMERIC(4,1),          -- 1-10 score
  weather_summary TEXT,
  injury_flags    JSONB DEFAULT '[]'::jsonb,
  situational_angles JSONB DEFAULT '[]'::jsonb,
  closing_line    INTEGER,                -- American odds at close
  clv             NUMERIC(6,3),           -- closing line value in %
  outcome         VARCHAR(10),            -- win, loss, push, void
  payout          NUMERIC(12,2)
);

CREATE INDEX IF NOT EXISTS idx_bets_sport ON bets(sport);
CREATE INDEX IF NOT EXISTS idx_bets_bet_type ON bets(bet_type);
CREATE INDEX IF NOT EXISTS idx_bets_created_at ON bets(created_at);
CREATE INDEX IF NOT EXISTS idx_bets_outcome ON bets(outcome);
CREATE INDEX IF NOT EXISTS idx_bets_game_date ON bets(game_date);

-- ── Situational Angles: reference database of proven trends ───────────────
CREATE TABLE IF NOT EXISTS situational_angles (
  id              SERIAL PRIMARY KEY,
  sport           VARCHAR(50) NOT NULL,
  name            VARCHAR(200) NOT NULL,
  description     TEXT NOT NULL,
  conditions      JSONB NOT NULL,
  historical_roi  NUMERIC(8,2),          -- % ROI
  sample_size     INTEGER NOT NULL DEFAULT 0,
  last_updated    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sit_angles_sport ON situational_angles(sport);

-- ── Line History: tracks line movement over time ──────────────────────────
CREATE TABLE IF NOT EXISTS line_history (
  id              SERIAL PRIMARY KEY,
  game_id         VARCHAR(200) NOT NULL,
  book            VARCHAR(100) NOT NULL,
  market          VARCHAR(50) NOT NULL,
  side            VARCHAR(100) NOT NULL,
  line            NUMERIC(10,2),
  odds            INTEGER NOT NULL,
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_line_hist_game ON line_history(game_id);
CREATE INDEX IF NOT EXISTS idx_line_hist_recorded ON line_history(recorded_at);

-- ── Performance Cache: pre-computed daily summaries ───────────────────────
CREATE TABLE IF NOT EXISTS performance_cache (
  id              SERIAL PRIMARY KEY,
  filter_key      VARCHAR(500) NOT NULL UNIQUE,
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  result_json     JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_perf_cache_key ON performance_cache(filter_key);

-- ── Elo Ratings: power ratings per team ───────────────────────────────────
CREATE TABLE IF NOT EXISTS elo_ratings (
  id              SERIAL PRIMARY KEY,
  sport           VARCHAR(50) NOT NULL,
  team            VARCHAR(200) NOT NULL,
  elo             INTEGER NOT NULL DEFAULT 1500,
  games_played    INTEGER NOT NULL DEFAULT 0,
  wins            INTEGER NOT NULL DEFAULT 0,
  losses          INTEGER NOT NULL DEFAULT 0,
  last_updated    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(sport, team)
);

CREATE INDEX IF NOT EXISTS idx_elo_sport ON elo_ratings(sport);
CREATE INDEX IF NOT EXISTS idx_elo_team ON elo_ratings(team);

-- ── Bankroll Ledger: tracks balance changes over time ─────────────────────
CREATE TABLE IF NOT EXISTS bankroll_ledger (
  id              SERIAL PRIMARY KEY,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  balance         NUMERIC(14,2) NOT NULL,
  action          VARCHAR(50) NOT NULL,  -- deposit, withdraw, set_balance, bet_result
  amount          NUMERIC(14,2) NOT NULL DEFAULT 0,
  note            TEXT
);

CREATE INDEX IF NOT EXISTS idx_bankroll_created ON bankroll_ledger(created_at);

-- ── Alerts: webhook alert configurations ──────────────────────────────────
CREATE TABLE IF NOT EXISTS alerts (
  id              SERIAL PRIMARY KEY,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  name            VARCHAR(200) NOT NULL,
  sport           VARCHAR(50) NOT NULL,
  alert_type      VARCHAR(50) NOT NULL,  -- value, arb, steam, odds_change
  threshold       NUMERIC(8,2) NOT NULL,
  webhook_url     TEXT NOT NULL,
  webhook_type    VARCHAR(50) NOT NULL DEFAULT 'generic',  -- discord, slack, generic
  active          BOOLEAN NOT NULL DEFAULT true,
  last_triggered  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_alerts_active ON alerts(active);
CREATE INDEX IF NOT EXISTS idx_alerts_sport ON alerts(sport);
