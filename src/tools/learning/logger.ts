/**
 * Bet Logger — stores bets with full context tags to Postgres.
 *
 * Critical: this writes the iter2 columns (no_vig_edge_pct, edge_is_no_vig,
 * no_vig_clv, data_quality, closing_pinnacle_no_vig_prob) so the CLV gate
 * downstream actually has data to read. If these fields are missing, the
 * gate is silently inert.
 */

import { isDatabaseConfigured, query } from "../../db/client.js";

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
  // ── iter2 fields ────
  no_vig_edge_pct?: number;
  edge_is_no_vig?: boolean;
  data_quality?: "real" | "inferred" | "prior" | "missing";
  closing_pinnacle_no_vig_prob?: number;
  // ── iter12 fields ────
  is_live?: boolean;
}

export interface BetLogResult {
  bet_id: number;
  message: string;
  warnings: string[];
}

export async function logBet(input: BetLogInput): Promise<BetLogResult> {
  if (!isDatabaseConfigured()) {
    throw new Error(
      "DATABASE_URL not configured. Bet logging requires a PostgreSQL database."
    );
  }

  const warnings: string[] = [];

  // Refuse to log a bet without bet_type — bet_type=unknown pollutes clusters
  // and breaks the CLV gate. Better to fail loud than silently corrupt clusters.
  if (!input.bet_type || input.bet_type === "unknown") {
    throw new Error(
      "log_bet requires bet_type (e.g., 'h2h', 'spread', 'total', 'prop'). " +
      "Logging with 'unknown' silently breaks the CLV gate."
    );
  }

  // Warn if no_vig fields are missing — the CLV gate works best with these.
  if (input.no_vig_edge_pct == null) {
    warnings.push(
      "no_vig_edge_pct not supplied — CLV gate accuracy will degrade. Compute via no_vig_fair_odds or find_value_line and pass it in."
    );
  }
  if (input.edge_is_no_vig == null) {
    warnings.push(
      "edge_is_no_vig flag not supplied — defaulting to false. Pass true if your edge_pct came from no-vig methodology."
    );
  }

  const rows = await query<{ id: number }>(
    `INSERT INTO bets (
      sport, league, game, game_date, bet_type, market, player_name,
      side, line, odds, stake, book, edge_pct, sharp_pct, public_pct,
      kelly_fraction, confidence_score, weather_summary, injury_flags,
      situational_angles,
      no_vig_edge_pct, edge_is_no_vig, data_quality, closing_pinnacle_no_vig_prob,
      is_live
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7,
      $8, $9, $10, $11, $12, $13, $14, $15,
      $16, $17, $18, $19, $20,
      $21, $22, $23, $24,
      $25
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
      input.no_vig_edge_pct ?? null,
      input.edge_is_no_vig ?? false,
      input.data_quality ?? "real",
      input.closing_pinnacle_no_vig_prob ?? null,
      input.is_live ?? false,
    ]
  );

  const betId = rows[0]?.id;
  if (!betId) throw new Error("Failed to insert bet — no ID returned.");

  return {
    bet_id: betId,
    message: `Bet #${betId} logged: ${input.side} @ ${input.odds} (${input.book}) — $${input.stake} stake`,
    warnings,
  };
}
