/**
 * PostgreSQL database client for the Betting MCP Server.
 * Handles connection pooling, schema initialization, and query helpers.
 */

import pg from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const { Pool } = pg;

let pool: pg.Pool | null = null;

/** Get or create the connection pool */
export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        "DATABASE_URL environment variable is required for database features. " +
          "Set it to your PostgreSQL connection string."
      );
    }
    pool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      ssl:
        process.env.NODE_ENV === "production"
          ? { rejectUnauthorized: false }
          : undefined,
    });
  }
  return pool;
}

/** Check if database is available */
export function isDatabaseConfigured(): boolean {
  return !!process.env.DATABASE_URL;
}

/** Initialize schema from schema.sql */
export async function initializeSchema(): Promise<void> {
  if (!isDatabaseConfigured()) {
    console.error(
      "[DB] DATABASE_URL not set — database features will be unavailable"
    );
    return;
  }

  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const schemaPath = join(__dirname, "schema.sql");
    const schema = readFileSync(schemaPath, "utf-8");
    const p = getPool();
    await p.query(schema);
    console.error("[DB] Schema initialized successfully");
  } catch (error) {
    console.error("[DB] Schema initialization failed:", error);
  }
}

/** Seed situational angles if the table is empty */
export async function seedSituationalAngles(): Promise<void> {
  if (!isDatabaseConfigured()) return;

  const p = getPool();
  const { rows } = await p.query(
    "SELECT COUNT(*) as count FROM situational_angles"
  );
  if (parseInt(rows[0].count) > 0) return;

  const angles = getSituationalAnglesSeed();
  for (const angle of angles) {
    await p.query(
      `INSERT INTO situational_angles (sport, name, description, conditions, historical_roi, sample_size)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        angle.sport,
        angle.name,
        angle.description,
        JSON.stringify(angle.conditions),
        angle.historical_roi,
        angle.sample_size,
      ]
    );
  }
  console.error(`[DB] Seeded ${angles.length} situational angles`);
}

/** Query helper that returns typed rows */
export async function query<T extends pg.QueryResultRow = Record<string, unknown>>(
  text: string,
  params?: unknown[]
): Promise<T[]> {
  const p = getPool();
  const result = await p.query<T>(text, params);
  return result.rows;
}

/** Query helper that returns a single row or null */
export async function queryOne<T extends pg.QueryResultRow = Record<string, unknown>>(
  text: string,
  params?: unknown[]
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/** Close the pool (for graceful shutdown) */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// ── Situational Angles Seed Data ─────────────────────────────────────────────

interface AngleSeed {
  sport: string;
  name: string;
  description: string;
  conditions: Record<string, unknown>;
  historical_roi: number;
  sample_size: number;
}

function getSituationalAnglesSeed(): AngleSeed[] {
  return [
    // ── NFL Angles ──
    {
      sport: "nfl",
      name: "Road Underdog Off Bye",
      description:
        "Road underdogs coming off a bye week have extra preparation time and tend to cover the spread.",
      conditions: { home_away: "away", favorite: false, off_bye: true },
      historical_roi: 8.7,
      sample_size: 312,
    },
    {
      sport: "nfl",
      name: "Home Favorite vs Divisional Opponent",
      description:
        "Home favorites in divisional games often see inflated lines due to public bias.",
      conditions: { home_away: "home", favorite: true, divisional: true },
      historical_roi: -3.2,
      sample_size: 540,
    },
    {
      sport: "nfl",
      name: "Short Week Road Team",
      description:
        "Teams playing on the road after a Thursday/Monday short week underperform.",
      conditions: { home_away: "away", short_week: true },
      historical_roi: -6.4,
      sample_size: 198,
    },
    {
      sport: "nfl",
      name: "Under in Cold Weather Divisional",
      description:
        "Divisional games in cold weather (<35F) tend to go under the total.",
      conditions: { divisional: true, temperature_below: 35, market: "total_under" },
      historical_roi: 5.1,
      sample_size: 167,
    },
    {
      sport: "nfl",
      name: "Road Dog After Blowout Loss",
      description:
        "Road underdogs that lost their previous game by 14+ points often bounce back.",
      conditions: { home_away: "away", favorite: false, prev_loss_margin_gte: 14 },
      historical_roi: 7.3,
      sample_size: 245,
    },
    {
      sport: "nfl",
      name: "Revenge Game Spot",
      description:
        "Teams facing an opponent that beat them earlier in the season cover at a higher rate.",
      conditions: { revenge_game: true },
      historical_roi: 4.5,
      sample_size: 289,
    },
    // ── NBA Angles ──
    {
      sport: "nba",
      name: "Back-to-Back Road Games",
      description:
        "Teams playing the second game of a back-to-back on the road underperform, especially as favorites.",
      conditions: { back_to_back: true, home_away: "away" },
      historical_roi: -4.8,
      sample_size: 820,
    },
    {
      sport: "nba",
      name: "4th Game in 5 Nights",
      description:
        "Teams playing their 4th game in 5 nights show significant fatigue effects.",
      conditions: { games_in_5_nights: 4 },
      historical_roi: -7.2,
      sample_size: 190,
    },
    {
      sport: "nba",
      name: "Revenge Game After Blowout",
      description:
        "Teams that lost to an opponent by 20+ points earlier cover at a high rate in the rematch.",
      conditions: { revenge_game: true, prev_loss_margin_gte: 20 },
      historical_roi: 9.1,
      sample_size: 145,
    },
    {
      sport: "nba",
      name: "Under in 3-in-4 Night Matchup",
      description:
        "Games where both teams are on a 3-in-4 night schedule tend to go under.",
      conditions: { both_teams_fatigued: true, market: "total_under" },
      historical_roi: 6.3,
      sample_size: 97,
    },
    {
      sport: "nba",
      name: "Home Underdog After 3+ Road Losses",
      description:
        "Home underdogs returning from a road trip where they lost 3+ games often bounce back.",
      conditions: { home_away: "home", favorite: false, returning_from_road_trip: true },
      historical_roi: 5.8,
      sample_size: 178,
    },
    // ── MLB Angles ──
    {
      sport: "mlb",
      name: "Facing Starter 3rd Time in Series",
      description:
        "Teams seeing a starting pitcher for the 3rd time in a series have better offensive numbers.",
      conditions: { times_faced_starter: 3 },
      historical_roi: 4.2,
      sample_size: 420,
    },
    {
      sport: "mlb",
      name: "Bullpen Overuse Previous Day",
      description:
        "Teams whose bullpen threw 4+ innings the previous day are more likely to lose.",
      conditions: { opponent_bullpen_innings_prev: 4 },
      historical_roi: 3.8,
      sample_size: 350,
    },
    {
      sport: "mlb",
      name: "Road Underdog with Ace Pitcher",
      description:
        "Road underdogs starting a top-tier pitcher (ERA < 3.00) provide value.",
      conditions: { home_away: "away", favorite: false, starter_era_below: 3.0 },
      historical_roi: 6.1,
      sample_size: 275,
    },
    {
      sport: "mlb",
      name: "Over in Day Game After Night Game",
      description:
        "Day games following night games tend to see tired pitchers and higher scoring.",
      conditions: { day_after_night: true, market: "total_over" },
      historical_roi: 3.5,
      sample_size: 310,
    },
    {
      sport: "mlb",
      name: "Home Dog in Divisional Play",
      description:
        "Home underdogs in divisional games have historically been profitable.",
      conditions: { home_away: "home", favorite: false, divisional: true },
      historical_roi: 5.3,
      sample_size: 485,
    },
    // ── NHL Angles ──
    {
      sport: "nhl",
      name: "3rd Game in 4 Nights",
      description:
        "Teams playing their third game in four nights show goaltending fatigue.",
      conditions: { games_in_4_nights: 3 },
      historical_roi: -5.5,
      sample_size: 260,
    },
    {
      sport: "nhl",
      name: "Home Underdog Off Loss",
      description:
        "Home underdogs that lost their previous game tend to play with more urgency.",
      conditions: { home_away: "home", favorite: false, lost_prev_game: true },
      historical_roi: 4.7,
      sample_size: 390,
    },
    {
      sport: "nhl",
      name: "Under in Back-to-Back",
      description:
        "Games where at least one team is on a back-to-back tend to go under the total.",
      conditions: { any_team_b2b: true, market: "total_under" },
      historical_roi: 3.9,
      sample_size: 445,
    },
    {
      sport: "nhl",
      name: "Road Favorite on Long Trip",
      description:
        "Road favorites on the 4th+ game of a road trip are often overvalued.",
      conditions: { home_away: "away", favorite: true, road_trip_game_gte: 4 },
      historical_roi: -4.1,
      sample_size: 155,
    },
    {
      sport: "nhl",
      name: "Backup Goalie Spot",
      description:
        "Fade teams starting their backup goalie, especially on the road.",
      conditions: { backup_goalie: true, home_away: "away" },
      historical_roi: -6.8,
      sample_size: 340,
    },
    {
      sport: "nhl",
      name: "Divisional Rivalry Under",
      description:
        "Divisional rivalry games with both teams in playoff contention tend toward unders.",
      conditions: { divisional: true, both_playoff_contending: true, market: "total_under" },
      historical_roi: 4.3,
      sample_size: 210,
    },
  ];
}
