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
  clv             NUMERIC(6,3),           -- closing line value in % (juiced — historical)
  no_vig_clv      NUMERIC(6,3),           -- closing line value in % (no-vig, sharper measure)
  closing_pinnacle_no_vig_prob NUMERIC(6,4), -- no-vig fair prob from sharp consensus at close
  no_vig_edge_pct NUMERIC(6,3),           -- no-vig edge at time of bet
  edge_is_no_vig  BOOLEAN DEFAULT FALSE,  -- whether stored edge_pct is no-vig
  data_quality    VARCHAR(20) DEFAULT 'real', -- real | inferred | prior | missing
  outcome         VARCHAR(10),            -- win, loss, push, void
  payout          NUMERIC(12,2)
);

-- Idempotent column adds for existing databases
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'bets' AND column_name = 'no_vig_clv') THEN
    ALTER TABLE bets ADD COLUMN no_vig_clv NUMERIC(6,3);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'bets' AND column_name = 'closing_pinnacle_no_vig_prob') THEN
    ALTER TABLE bets ADD COLUMN closing_pinnacle_no_vig_prob NUMERIC(6,4);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'bets' AND column_name = 'no_vig_edge_pct') THEN
    ALTER TABLE bets ADD COLUMN no_vig_edge_pct NUMERIC(6,3);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'bets' AND column_name = 'edge_is_no_vig') THEN
    ALTER TABLE bets ADD COLUMN edge_is_no_vig BOOLEAN DEFAULT FALSE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'bets' AND column_name = 'data_quality') THEN
    ALTER TABLE bets ADD COLUMN data_quality VARCHAR(20) DEFAULT 'real';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_bets_sport ON bets(sport);
CREATE INDEX IF NOT EXISTS idx_bets_bet_type ON bets(bet_type);
CREATE INDEX IF NOT EXISTS idx_bets_created_at ON bets(created_at);
CREATE INDEX IF NOT EXISTS idx_bets_outcome ON bets(outcome);
CREATE INDEX IF NOT EXISTS idx_bets_game_date ON bets(game_date);

-- ── Situational Angles: reference database of proven trends ───────────────
-- data_quality: 'prior' (seeded folklore), 'real' (measured from user data)
CREATE TABLE IF NOT EXISTS situational_angles (
  id              SERIAL PRIMARY KEY,
  sport           VARCHAR(50) NOT NULL,
  name            VARCHAR(200) NOT NULL,
  description     TEXT NOT NULL,
  conditions      JSONB NOT NULL,
  historical_roi  NUMERIC(8,2),          -- % ROI
  sample_size     INTEGER NOT NULL DEFAULT 0,
  data_quality    VARCHAR(20) NOT NULL DEFAULT 'prior',
  last_updated    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotent column add for existing databases
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'situational_angles' AND column_name = 'data_quality'
  ) THEN
    ALTER TABLE situational_angles ADD COLUMN data_quality VARCHAR(20) NOT NULL DEFAULT 'prior';
  END IF;
END $$;

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

-- ── Opening Lines: first-captured odds for each game ────────────────────────
CREATE TABLE IF NOT EXISTS opening_lines (
  id              SERIAL PRIMARY KEY,
  game_id         VARCHAR(200) NOT NULL,
  sport           VARCHAR(50) NOT NULL,
  game            VARCHAR(200) NOT NULL,
  book            VARCHAR(100) NOT NULL,
  market          VARCHAR(50) NOT NULL,
  side            VARCHAR(100) NOT NULL,
  odds            INTEGER NOT NULL,
  line            NUMERIC(10,2),
  captured_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(game_id, book, market, side)
);

CREATE INDEX IF NOT EXISTS idx_opening_lines_game ON opening_lines(game_id);
CREATE INDEX IF NOT EXISTS idx_opening_lines_sport ON opening_lines(sport);

-- ── Prop Hit Rate: tracks per-player per-game actual stats ──────────────────
-- We store the ACTUAL stat per game, not pre-computed hit rates. Hit rate vs
-- any current line is computed on the fly: count(actual_value > line) / count.
-- This way the backfill doesn't need historical book lines (which aren't
-- available from free APIs).
CREATE TABLE IF NOT EXISTS prop_hit_rates (
  id              SERIAL PRIMARY KEY,
  player_name     VARCHAR(200) NOT NULL,
  sport           VARCHAR(50) NOT NULL,
  market          VARCHAR(50) NOT NULL,
  line            NUMERIC(10,2),                  -- NULL when no line was offered
  actual_value    NUMERIC(10,2),
  hit             BOOLEAN,                        -- legacy: true = over hit (only when line known)
  game_date       DATE NOT NULL,
  game            VARCHAR(200),
  source          VARCHAR(50),                    -- 'balldontlie' | 'mlb_statsapi' | 'nhl_api' | 'nflverse' | 'manual'
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(player_name, sport, market, game_date)
);

-- Idempotent migrations for existing databases
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'prop_hit_rates' AND column_name = 'source') THEN
    ALTER TABLE prop_hit_rates ADD COLUMN source VARCHAR(50);
  END IF;
  -- Drop NOT NULL on `line` if present (legacy schema)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'prop_hit_rates' AND column_name = 'line' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE prop_hit_rates ALTER COLUMN line DROP NOT NULL;
  END IF;
  -- Add unique constraint if not present
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'prop_hit_rates_player_name_sport_market_game_date_key'
  ) THEN
    BEGIN
      ALTER TABLE prop_hit_rates
        ADD CONSTRAINT prop_hit_rates_player_name_sport_market_game_date_key
        UNIQUE(player_name, sport, market, game_date);
    EXCEPTION WHEN unique_violation THEN
      -- Pre-existing duplicates; leave it. Backfill upserts will still work via ON CONFLICT DO NOTHING.
      NULL;
    END;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_prop_hits_player ON prop_hit_rates(player_name);
CREATE INDEX IF NOT EXISTS idx_prop_hits_sport ON prop_hit_rates(sport, market);
CREATE INDEX IF NOT EXISTS idx_prop_hits_date ON prop_hit_rates(game_date);

-- ── Market Bankroll Allocations ─────────────────────────────────────────────
-- Per (sport, bet_type, book) Kelly fraction overrides driven by realized CLV.
-- A market with strong +CLV gets a higher fraction; a market with -CLV gets 0.
CREATE TABLE IF NOT EXISTS market_bankroll_allocations (
  id              SERIAL PRIMARY KEY,
  sport           VARCHAR(50) NOT NULL,
  bet_type        VARCHAR(50) NOT NULL,
  book            VARCHAR(100),                  -- nullable: NULL means all books
  allocation_pct  NUMERIC(6,3) NOT NULL,         -- % of bankroll allowed for this cluster
  kelly_fraction  NUMERIC(4,3) NOT NULL DEFAULT 0.25,
  basis           VARCHAR(50) NOT NULL,          -- 'manual' | 'auto_clv' | 'auto_roi'
  basis_metric    NUMERIC(6,3),                  -- the CLV/ROI value that drove it
  basis_n         INTEGER,                       -- sample size
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(sport, bet_type, book)
);

CREATE INDEX IF NOT EXISTS idx_mba_cluster ON market_bankroll_allocations(sport, bet_type);

-- ── Bet Rejections (audit log of plays the system refused) ─────────────────
-- Recording rejections is critical: it lets you see what the gates are doing,
-- and lets you backtest whether the gates are too strict or too loose.
CREATE TABLE IF NOT EXISTS bet_rejections (
  id              SERIAL PRIMARY KEY,
  rejected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sport           VARCHAR(50) NOT NULL,
  bet_type        VARCHAR(50),
  book            VARCHAR(100),
  side            VARCHAR(200),
  game            VARCHAR(200),
  game_date       DATE,
  no_vig_edge_pct NUMERIC(6,3),
  reason          VARCHAR(50) NOT NULL,          -- 'clv_gate' | 'drift_gate' | 'edge_floor' | 'data_quality' | 'manual'
  reason_detail   TEXT,
  raw_signal      JSONB
);

CREATE INDEX IF NOT EXISTS idx_rejections_sport ON bet_rejections(sport);
CREATE INDEX IF NOT EXISTS idx_rejections_reason ON bet_rejections(reason);
CREATE INDEX IF NOT EXISTS idx_rejections_at ON bet_rejections(rejected_at);
