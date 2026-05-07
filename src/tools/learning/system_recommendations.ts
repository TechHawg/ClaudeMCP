/**
 * System recommendations tracker.
 *
 * Every screen_plays call writes its surfaced plays here so we can compare
 * "what the system recommended" vs "what the user actually bet" — and so
 * we can backtest the system in isolation even if the user skips most plays.
 *
 * The auto-settle service marks outcomes on these rows the same way it does
 * for `bets`. Use `system_performance` to query the resulting track record.
 */

import { isDatabaseConfigured, query } from "../../db/client.js";

export interface SystemRecommendationInput {
  scan_id: string;
  sport: string;
  market: string;
  game: string;
  side: string;
  point?: number;
  best_book: string;
  best_price: number;
  no_vig_edge_pct?: number;
  ev_percentage?: number;
  recommended_stake?: number;
  kelly_fraction?: number;
  raw_signal?: Record<string, unknown>;
}

export async function logSystemRecommendations(
  scanId: string,
  recs: SystemRecommendationInput[]
): Promise<number> {
  if (!isDatabaseConfigured() || recs.length === 0) return 0;

  const placeholders: string[] = [];
  const args: unknown[] = [];
  let p = 1;
  for (const r of recs) {
    placeholders.push(
      `($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`
    );
    args.push(
      scanId,
      r.sport,
      r.market,
      r.game,
      r.side,
      r.point ?? null,
      r.best_book,
      r.best_price,
      r.no_vig_edge_pct ?? null,
      r.ev_percentage ?? null,
      r.recommended_stake ?? null,
      r.kelly_fraction ?? null
    );
  }

  const result = await query<{ id: number }>(
    `INSERT INTO system_recommendations
       (scan_id, sport, market, game, side, point, best_book, best_price,
        no_vig_edge_pct, ev_percentage, recommended_stake, kelly_fraction)
     VALUES ${placeholders.join(", ")}
     RETURNING id`,
    args
  );
  return result.length;
}

export interface SystemPerformanceFilters {
  sport?: string;
  market?: string;
  date_from?: string;
  date_to?: string;
}

export interface SystemPerformanceResult {
  filters: SystemPerformanceFilters;
  total_recommended: number;
  settled: number;
  wins: number;
  losses: number;
  pushes: number;
  open: number;
  win_rate_pct: number;
  paper_total_stake: number;
  paper_total_payout: number;
  paper_profit: number;
  paper_roi_pct: number;
  avg_no_vig_clv_pct: number | null;
  by_sport: Array<{ sport: string; bets: number; profit: number; roi_pct: number }>;
  notes: string[];
}

export async function getSystemPerformance(
  filters: SystemPerformanceFilters = {}
): Promise<SystemPerformanceResult> {
  const notes: string[] = [];
  if (!isDatabaseConfigured()) {
    return {
      filters,
      total_recommended: 0, settled: 0, wins: 0, losses: 0, pushes: 0, open: 0,
      win_rate_pct: 0, paper_total_stake: 0, paper_total_payout: 0,
      paper_profit: 0, paper_roi_pct: 0, avg_no_vig_clv_pct: null,
      by_sport: [], notes: ["DATABASE_URL not set."],
    };
  }

  const where: string[] = ["1=1"];
  const args: unknown[] = [];
  if (filters.sport) { where.push(`sport = $${args.length + 1}`); args.push(filters.sport); }
  if (filters.market) { where.push(`market = $${args.length + 1}`); args.push(filters.market); }
  if (filters.date_from) { where.push(`recommended_at >= $${args.length + 1}`); args.push(filters.date_from); }
  if (filters.date_to) { where.push(`recommended_at <= $${args.length + 1}`); args.push(filters.date_to); }

  const rows = await query<{
    sport: string;
    outcome: string | null;
    recommended_stake: string | number | null;
    paper_payout: string | number | null;
    no_vig_clv: string | number | null;
  }>(
    `SELECT sport, outcome, recommended_stake, paper_payout, no_vig_clv
       FROM system_recommendations
       WHERE ${where.join(" AND ")}`,
    args
  );

  let wins = 0, losses = 0, pushes = 0, open = 0;
  let stake = 0, payout = 0;
  let clvSum = 0, clvCount = 0;
  const bySport = new Map<string, { bets: number; profit: number; stake: number }>();

  for (const r of rows) {
    const s = Number(r.recommended_stake ?? 0);
    const p = r.paper_payout != null ? Number(r.paper_payout) : 0;

    if (r.outcome === "win") { wins++; stake += s; payout += p; }
    else if (r.outcome === "loss") { losses++; stake += s; }
    else if (r.outcome === "push") { pushes++; stake += s; payout += s; }
    else { open++; }

    if (r.no_vig_clv != null) { clvSum += Number(r.no_vig_clv); clvCount++; }

    if (!bySport.has(r.sport)) bySport.set(r.sport, { bets: 0, profit: 0, stake: 0 });
    const ent = bySport.get(r.sport)!;
    if (r.outcome && r.outcome !== "void") {
      ent.bets++;
      ent.stake += s;
      ent.profit += (p - s);
    }
  }

  const decided = wins + losses;
  const profit = payout - stake;
  return {
    filters,
    total_recommended: rows.length,
    settled: wins + losses + pushes,
    wins, losses, pushes, open,
    win_rate_pct: decided > 0 ? Number(((wins / decided) * 100).toFixed(2)) : 0,
    paper_total_stake: Number(stake.toFixed(2)),
    paper_total_payout: Number(payout.toFixed(2)),
    paper_profit: Number(profit.toFixed(2)),
    paper_roi_pct: stake > 0 ? Number(((profit / stake) * 100).toFixed(2)) : 0,
    avg_no_vig_clv_pct: clvCount > 0 ? Number((clvSum / clvCount).toFixed(3)) : null,
    by_sport: [...bySport.entries()].map(([sport, e]) => ({
      sport,
      bets: e.bets,
      profit: Number(e.profit.toFixed(2)),
      roi_pct: e.stake > 0 ? Number(((e.profit / e.stake) * 100).toFixed(2)) : 0,
    })),
    notes,
  };
}
