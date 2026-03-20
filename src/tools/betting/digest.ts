/**
 * Daily Digest — Morning briefing tool.
 * Aggregates today's games, value plays, sharp action, injuries,
 * consensus, bankroll, and yesterday's results in one call.
 */

import { getLiveOdds, GameOdds } from "./odds.js";
import { findValueLines } from "./value.js";
import { getSharpAction } from "./sharp.js";
import { getInjuryReport } from "./injury.js";
import { getConsensusPicks } from "./consensus.js";
import { manageBankroll } from "../learning/bankroll.js";
import { isDatabaseConfigured, query } from "../../db/client.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface DailyDigest {
  todays_games: {
    sport: string;
    game_count: number;
    games: { home: string; away: string; commence_time: string }[];
  }[];
  top_value_plays: unknown[];
  sharp_action_summary: unknown[];
  key_injuries: unknown[];
  consensus_splits: unknown[];
  bankroll_status: Record<string, unknown>;
  yesterday_results: {
    bets: number;
    wins: number;
    losses: number;
    profit: number;
    roi: number;
  };
  generated_at: string;
}

// ── Implementation ───────────────────────────────────────────────────────────

export async function getDailyDigest(params: {
  sports?: string[];
} = {}): Promise<DailyDigest> {
  const sports = params.sports ?? ["nba", "mlb", "nhl"];

  const digest: DailyDigest = {
    todays_games: [],
    top_value_plays: [],
    sharp_action_summary: [],
    key_injuries: [],
    consensus_splits: [],
    bankroll_status: {},
    yesterday_results: { bets: 0, wins: 0, losses: 0, profit: 0, roi: 0 },
    generated_at: new Date().toISOString(),
  };

  // ── Section 1: Today's games ─────────────────────────────────────────────
  for (const sport of sports) {
    try {
      const games: GameOdds[] = await getLiveOdds({ sport });
      digest.todays_games.push({
        sport,
        game_count: games.length,
        games: games.map((g) => ({
          home: g.home_team,
          away: g.away_team,
          commence_time: g.commence_time,
        })),
      });
    } catch (error) {
      console.error(`[Digest] Failed to fetch games for ${sport}:`, error);
    }
  }

  // ── Section 2: Top value plays ───────────────────────────────────────────
  for (const sport of sports) {
    try {
      const values = await findValueLines({ sport });
      if (Array.isArray(values)) {
        digest.top_value_plays.push(
          ...values.slice(0, 3).map((v: Record<string, unknown>) => ({
            sport,
            ...v,
          }))
        );
      }
    } catch (error) {
      console.error(`[Digest] Failed to fetch value lines for ${sport}:`, error);
    }
  }
  // Sort by EV and keep top 5
  digest.top_value_plays = (digest.top_value_plays as Record<string, unknown>[])
    .sort((a, b) => (Number(b.ev_percentage ?? 0)) - (Number(a.ev_percentage ?? 0)))
    .slice(0, 5);

  // ── Section 3: Sharp action summary ──────────────────────────────────────
  for (const sport of sports) {
    try {
      const sharp = await getSharpAction({ sport });
      if (Array.isArray(sharp)) {
        const rlmGames = sharp.filter(
          (g) => (g as unknown as Record<string, unknown>).reverse_line_movement || (g as unknown as Record<string, unknown>).steam_move_alert
        );
        digest.sharp_action_summary.push(...rlmGames.slice(0, 3));
      }
    } catch (error) {
      console.error(`[Digest] Failed to fetch sharp action for ${sport}:`, error);
    }
  }

  // ── Section 4: Key injuries ──────────────────────────────────────────────
  for (const sport of sports) {
    try {
      const report = await getInjuryReport({ sport });
      if (report?.injuries) {
        const critical = report.injuries.filter(
          (inj) => inj.impact_severity === "critical" || inj.impact_severity === "significant"
        );
        digest.key_injuries.push(
          ...critical.map((inj) => ({ sport, ...inj }))
        );
      }
    } catch (error) {
      console.error(`[Digest] Failed to fetch injuries for ${sport}:`, error);
    }
  }

  // ── Section 5: Consensus splits ──────────────────────────────────────────
  for (const sport of sports) {
    try {
      const consensus = await getConsensusPicks({ sport });
      if (Array.isArray(consensus)) {
        digest.consensus_splits.push(...consensus.slice(0, 3));
      }
    } catch (error) {
      console.error(`[Digest] Failed to fetch consensus for ${sport}:`, error);
    }
  }

  // ── Section 6: Bankroll status ───────────────────────────────────────────
  try {
    const bankroll = await manageBankroll({ action: "status" });
    if (bankroll?.status) {
      const s = bankroll.status as unknown as Record<string, unknown>;
      digest.bankroll_status = {
        balance: s.current_balance,
        drawdown_pct: s.current_drawdown_pct,
        today_profit: (s.today as Record<string, unknown>)?.profit ?? 0,
        week_profit: (s.this_week as Record<string, unknown>)?.profit ?? 0,
        total_roi_pct: s.total_roi_pct,
      };
    }
  } catch (error) {
    console.error("[Digest] Failed to fetch bankroll:", error);
  }

  // ── Section 7: Yesterday's results ───────────────────────────────────────
  try {
    if (isDatabaseConfigured()) {
      const result = await query(
        `SELECT outcome, stake, payout FROM bets
         WHERE game_date = CURRENT_DATE - 1 AND outcome IS NOT NULL`
      );
      const rows = (result as Record<string, unknown>[]) ?? [];
      if (rows.length > 0) {
        const wins = rows.filter((r) => r.outcome === "win").length;
        const losses = rows.filter((r) => r.outcome === "loss").length;
        const totalStake = rows.reduce((s, r) => s + Number(r.stake ?? 0), 0);
        const totalPayout = rows.reduce((s, r) => s + Number(r.payout ?? 0), 0);
        const profit = totalPayout - totalStake;

        digest.yesterday_results = {
          bets: rows.length,
          wins,
          losses,
          profit: Math.round(profit * 100) / 100,
          roi: totalStake > 0 ? Math.round((profit / totalStake) * 10000) / 100 : 0,
        };
      }
    }
  } catch (error) {
    console.error("[Digest] Failed to fetch yesterday's results:", error);
  }

  return digest;
}
