/**
 * Strategy backtest — replay a strategy spec against logged bets and report
 * what would have happened if the system had only recommended bets matching
 * the spec. This is how you tune the gates and edge floors empirically.
 */

import { isDatabaseConfigured, query } from "../../db/client.js";

export interface StrategyFilters {
  sport?: string;
  bet_type?: string;
  book?: string;
  min_edge_pct?: number;
  min_no_vig_edge_pct?: number;
  min_confidence?: number;
  edge_is_no_vig?: boolean;
  date_from?: string;
  date_to?: string;
}

export interface BacktestResult {
  filters: StrategyFilters;
  bets: number;
  wins: number;
  losses: number;
  pushes: number;
  win_rate_pct: number;
  total_stake: number;
  total_payout: number;
  profit: number;
  roi_pct: number;
  avg_clv_pct: number;
  avg_no_vig_clv_pct: number | null;
  /** Profit assuming flat 1u stake per bet, regardless of recorded stake. */
  flat_unit_profit: number;
  notes: string[];
}

export async function backtestStrategy(filters: StrategyFilters): Promise<BacktestResult> {
  const notes: string[] = [];
  if (!isDatabaseConfigured()) {
    return {
      filters,
      bets: 0,
      wins: 0,
      losses: 0,
      pushes: 0,
      win_rate_pct: 0,
      total_stake: 0,
      total_payout: 0,
      profit: 0,
      roi_pct: 0,
      avg_clv_pct: 0,
      avg_no_vig_clv_pct: null,
      flat_unit_profit: 0,
      notes: ["DATABASE_URL not set — backtest requires Postgres."],
    };
  }

  const where: string[] = ["outcome IN ('win','loss','push')"];
  const args: unknown[] = [];

  if (filters.sport) {
    where.push(`sport = $${args.length + 1}`);
    args.push(filters.sport);
  }
  if (filters.bet_type) {
    where.push(`bet_type = $${args.length + 1}`);
    args.push(filters.bet_type);
  }
  if (filters.book) {
    where.push(`book = $${args.length + 1}`);
    args.push(filters.book);
  }
  if (filters.min_edge_pct != null) {
    where.push(`edge_pct >= $${args.length + 1}`);
    args.push(filters.min_edge_pct);
  }
  if (filters.min_no_vig_edge_pct != null) {
    where.push(`no_vig_edge_pct >= $${args.length + 1}`);
    args.push(filters.min_no_vig_edge_pct);
  }
  if (filters.min_confidence != null) {
    where.push(`confidence_score >= $${args.length + 1}`);
    args.push(filters.min_confidence);
  }
  if (filters.edge_is_no_vig != null) {
    where.push(`edge_is_no_vig = $${args.length + 1}`);
    args.push(filters.edge_is_no_vig);
  }
  if (filters.date_from) {
    where.push(`created_at >= $${args.length + 1}`);
    args.push(filters.date_from);
  }
  if (filters.date_to) {
    where.push(`created_at <= $${args.length + 1}`);
    args.push(filters.date_to);
  }

  const rows = await query<{
    outcome: "win" | "loss" | "push";
    odds: number;
    stake: string | number;
    payout: string | number | null;
    clv: string | number | null;
    no_vig_clv: string | number | null;
  }>(
    `SELECT outcome, odds, stake, payout, clv, no_vig_clv
       FROM bets
       WHERE ${where.join(" AND ")}`,
    args
  );

  if (rows.length === 0) {
    notes.push("No matching bets found.");
    return {
      filters,
      bets: 0,
      wins: 0,
      losses: 0,
      pushes: 0,
      win_rate_pct: 0,
      total_stake: 0,
      total_payout: 0,
      profit: 0,
      roi_pct: 0,
      avg_clv_pct: 0,
      avg_no_vig_clv_pct: null,
      flat_unit_profit: 0,
      notes,
    };
  }

  let wins = 0, losses = 0, pushes = 0;
  let totalStake = 0, totalPayout = 0;
  let clvSum = 0, clvCount = 0;
  let noVigClvSum = 0, noVigClvCount = 0;
  let flatProfit = 0;

  for (const r of rows) {
    const stake = Number(r.stake);
    const payout = r.payout == null ? 0 : Number(r.payout);
    totalStake += stake;
    totalPayout += payout;
    if (r.outcome === "win") {
      wins++;
      // Flat 1u: 1u stake, payoff in net units
      const dec = r.odds > 0 ? r.odds / 100 + 1 : 100 / -r.odds + 1;
      flatProfit += dec - 1;
    } else if (r.outcome === "loss") {
      losses++;
      flatProfit -= 1;
    } else if (r.outcome === "push") {
      pushes++;
    }
    if (r.clv != null) {
      clvSum += Number(r.clv);
      clvCount++;
    }
    if (r.no_vig_clv != null) {
      noVigClvSum += Number(r.no_vig_clv);
      noVigClvCount++;
    }
  }

  const decided = wins + losses;
  const winRate = decided > 0 ? (wins / decided) * 100 : 0;
  const profit = totalPayout - totalStake;
  const roi = totalStake > 0 ? (profit / totalStake) * 100 : 0;
  const avgClv = clvCount > 0 ? clvSum / clvCount : 0;
  const avgNoVigClv = noVigClvCount > 0 ? noVigClvSum / noVigClvCount : null;

  if (rows.length < 30) {
    notes.push(`Only ${rows.length} bets — sample size too small for reliable conclusions (need ≥100 for stable estimates).`);
  }

  return {
    filters,
    bets: rows.length,
    wins,
    losses,
    pushes,
    win_rate_pct: Number(winRate.toFixed(2)),
    total_stake: Number(totalStake.toFixed(2)),
    total_payout: Number(totalPayout.toFixed(2)),
    profit: Number(profit.toFixed(2)),
    roi_pct: Number(roi.toFixed(2)),
    avg_clv_pct: Number(avgClv.toFixed(3)),
    avg_no_vig_clv_pct: avgNoVigClv != null ? Number(avgNoVigClv.toFixed(3)) : null,
    flat_unit_profit: Number(flatProfit.toFixed(2)),
    notes,
  };
}
