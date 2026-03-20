/**
 * Bet Logger — stores bets with full context tags to Postgres.
 */

import { isDatabaseConfigured, query, queryOne } from "../../db/client.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface BetLogInput {
  sport: string;
  league?: string;
  game: string;
  game_date?: string;
  bet_type: string;
  market?: string;
  player_name?: string;
  side: string;
  line?: number;
  odds: number;
  stake: number;
  book: string;
  edge_pct?: number;
  sharp_pct?: number;
  public_pct?: number;
  kelly_fraction?: number;
  confidence_score?: number;
  weather_summary?: string;
  injury_flags?: unknown[];
  situational_angles?: unknown[];
}

export interface BetLogResult {
  bet_id: number;
  message: string;
}

// ── Implementation ───────────────────────────────────────────────────────────

export async function logBet(input: BetLogInput): Promise<BetLogResult> {
  if (!isDatabaseConfigured()) {
    throw new Error(
      "DATABASE_URL not configured. Bet logging requires a PostgreSQL database. " +
        "Add a Postgres plugin on Railway or set DATABASE_URL manually."
    );
  }

  const rows = await query<{ id: number }>(
    `INSERT INTO bets (
      sport, league, game, game_date, bet_type, market, player_name,
      side, line, odds, stake, book, edge_pct, sharp_pct, public_pct,
      kelly_fraction, confidence_score, weather_summary, injury_flags,
      situational_angles
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7,
      $8, $9, $10, $11, $12, $13, $14, $15,
      $16, $17, $18, $19, $20
    ) RETURNING id`,
    [
      input.sport,
      input.league ?? null,
      input.game,
      input.game_date ?? null,
      input.bet_type,
      input.market ?? null,
      input.player_name ?? null,
      input.side,
      input.line ?? null,
      input.odds,
      input.stake,
      input.book,
      input.edge_pct ?? null,
      input.sharp_pct ?? null,
      input.public_pct ?? null,
      input.kelly_fraction ?? null,
      input.confidence_score ?? null,
      input.weather_summary ?? null,
      JSON.stringify(input.injury_flags ?? []),
      JSON.stringify(input.situational_angles ?? []),
    ]
  );

  const betId = rows[0]?.id;
  if (!betId) throw new Error("Failed to insert bet — no ID returned.");

  return {
    bet_id: betId,
    message: `Bet #${betId} logged: ${input.side} @ ${input.odds} (${input.book}) — $${input.stake} stake`,
  };
}
