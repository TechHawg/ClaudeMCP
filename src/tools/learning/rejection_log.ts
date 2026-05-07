/**
 * Bet rejection log — records every play the gates rejected.
 *
 * This is critical for auditing: if you find out you've been "missing winners"
 * because the system refuses too aggressively, you can backtest the rejection
 * stream against actual outcomes and tune the gates.
 */

import { isDatabaseConfigured, query } from "../../db/client.js";

export interface BetRejection {
  sport: string;
  bet_type?: string;
  book?: string;
  side?: string;
  game?: string;
  game_date?: string;
  no_vig_edge_pct?: number;
  reason: string;
  reason_detail?: string;
  raw_signal?: Record<string, unknown>;
}

export async function logBetRejection(rejection: BetRejection): Promise<void> {
  if (!isDatabaseConfigured()) return;
  try {
    await query(
      `INSERT INTO bet_rejections
        (sport, bet_type, book, side, game, game_date, no_vig_edge_pct,
         reason, reason_detail, raw_signal)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        rejection.sport,
        rejection.bet_type ?? null,
        rejection.book ?? null,
        rejection.side ?? null,
        rejection.game ?? null,
        rejection.game_date ?? null,
        rejection.no_vig_edge_pct ?? null,
        rejection.reason,
        rejection.reason_detail ?? null,
        rejection.raw_signal ? JSON.stringify(rejection.raw_signal) : null,
      ]
    );
  } catch (err) {
    console.error("[Rejection] log failed:", err);
  }
}

export async function queryRejections(params: {
  sport?: string;
  reason?: string;
  hours_back?: number;
  limit?: number;
}): Promise<{
  rows: Array<{
    rejected_at: string;
    sport: string;
    bet_type: string | null;
    book: string | null;
    side: string | null;
    game: string | null;
    no_vig_edge_pct: number | null;
    reason: string;
    reason_detail: string | null;
  }>;
  summary: Record<string, number>;
}> {
  if (!isDatabaseConfigured()) return { rows: [], summary: {} };
  const filters: string[] = [];
  const args: unknown[] = [];
  if (params.sport) {
    filters.push(`sport = $${args.length + 1}`);
    args.push(params.sport);
  }
  if (params.reason) {
    filters.push(`reason = $${args.length + 1}`);
    args.push(params.reason);
  }
  if (params.hours_back) {
    filters.push(`rejected_at > NOW() - ($${args.length + 1}::int || ' hours')::interval`);
    args.push(params.hours_back);
  }
  const whereClause = filters.length ? "WHERE " + filters.join(" AND ") : "";
  const limit = Math.max(1, Math.min(params.limit ?? 200, 1000));

  const rows = await query<{
    rejected_at: string;
    sport: string;
    bet_type: string | null;
    book: string | null;
    side: string | null;
    game: string | null;
    no_vig_edge_pct: string | number | null;
    reason: string;
    reason_detail: string | null;
  }>(
    `SELECT rejected_at, sport, bet_type, book, side, game, no_vig_edge_pct, reason, reason_detail
       FROM bet_rejections
       ${whereClause}
       ORDER BY rejected_at DESC
       LIMIT ${limit}`,
    args
  );

  const summary: Record<string, number> = {};
  for (const r of rows) {
    summary[r.reason] = (summary[r.reason] ?? 0) + 1;
  }

  return {
    rows: rows.map((r) => ({
      ...r,
      no_vig_edge_pct: r.no_vig_edge_pct == null ? null : Number(r.no_vig_edge_pct),
    })),
    summary,
  };
}
