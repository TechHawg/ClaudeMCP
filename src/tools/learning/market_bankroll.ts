/**
 * Per-market bankroll allocation.
 *
 * The single global bankroll + uniform Kelly fraction model is wrong when
 * realized edges differ across markets. If you have +CLV on NHL totals and
 * -CLV on NFL props, your sizing should reflect that asymmetrically. This
 * tool computes a per-cluster Kelly fraction from realized data and writes
 * it to market_bankroll_allocations for the sizing logic to consume.
 *
 * Decision rule:
 *  - n < 30 settled bets → no override (use default 0.25)
 *  - avg no-vig CLV ≥ +1% → 0.30 (boost)
 *  - avg no-vig CLV ≥ +0.25% → 0.25 (default)
 *  - avg no-vig CLV between -0.5% and +0.25% → 0.10 (haircut)
 *  - avg no-vig CLV ≤ -0.5% → 0.0 (DO NOT BET this cluster)
 */

import { isDatabaseConfigured, query } from "../../db/client.js";

export interface MarketAllocation {
  sport: string;
  bet_type: string;
  book: string | null;
  bets: number;
  avg_no_vig_clv_pct: number;
  avg_clv_pct: number;
  roi_pct: number;
  recommended_kelly_fraction: number;
  recommended_allocation_pct: number;
  basis: string;
  rationale: string;
}

export async function manageMarketBankroll(params: {
  action?: "list" | "compute" | "get";
  sport?: string;
  bet_type?: string;
  book?: string;
  /** Lookback in days (default 90). */
  lookback_days?: number;
  /** Minimum bets per cluster to apply an override (default 30). */
  min_bets?: number;
}): Promise<{
  action: string;
  allocations: MarketAllocation[];
  notes: string[];
}> {
  if (!isDatabaseConfigured()) {
    return {
      action: params.action ?? "list",
      allocations: [],
      notes: ["DATABASE_URL not set — per-market bankroll requires Postgres."],
    };
  }

  const action = params.action ?? "compute";
  const minBets = params.min_bets ?? 30;
  const lookback = params.lookback_days ?? 90;
  const notes: string[] = [];

  if (action === "list" || action === "get") {
    const filters: string[] = [];
    const args: unknown[] = [];
    if (params.sport) {
      filters.push(`sport = $${args.length + 1}`);
      args.push(params.sport);
    }
    if (params.bet_type) {
      filters.push(`bet_type = $${args.length + 1}`);
      args.push(params.bet_type);
    }
    if (params.book) {
      filters.push(`book = $${args.length + 1}`);
      args.push(params.book);
    }
    const whereClause = filters.length ? "WHERE " + filters.join(" AND ") : "";

    const rows = await query<{
      sport: string;
      bet_type: string;
      book: string | null;
      allocation_pct: string | number;
      kelly_fraction: string | number;
      basis: string;
      basis_metric: string | number | null;
      basis_n: number | null;
    }>(
      `SELECT sport, bet_type, book, allocation_pct, kelly_fraction, basis, basis_metric, basis_n
         FROM market_bankroll_allocations
         ${whereClause}
         ORDER BY allocation_pct DESC`,
      args
    );

    const allocations: MarketAllocation[] = rows.map((r) => ({
      sport: r.sport,
      bet_type: r.bet_type,
      book: r.book,
      bets: r.basis_n ?? 0,
      avg_no_vig_clv_pct: 0,
      avg_clv_pct: Number(r.basis_metric ?? 0),
      roi_pct: 0,
      recommended_kelly_fraction: Number(r.kelly_fraction),
      recommended_allocation_pct: Number(r.allocation_pct),
      basis: r.basis,
      rationale: "Stored allocation from previous compute.",
    }));

    return { action, allocations, notes };
  }

  // action === "compute": recompute from bets table and upsert into table.
  const rows = await query<{
    sport: string;
    bet_type: string;
    book: string;
    n: string | number;
    avg_no_vig_clv: string | number | null;
    avg_clv: string | number | null;
    total_stake: string | number;
    total_payout: string | number;
  }>(
    `SELECT sport,
            bet_type,
            book,
            COUNT(*) AS n,
            AVG(no_vig_clv)::float AS avg_no_vig_clv,
            AVG(clv)::float AS avg_clv,
            SUM(stake) AS total_stake,
            COALESCE(SUM(payout), 0) AS total_payout
       FROM bets
      WHERE outcome IN ('win', 'loss', 'push')
        AND created_at > NOW() - ($1::int || ' days')::interval
      GROUP BY sport, bet_type, book
      HAVING COUNT(*) >= $2`,
    [lookback, minBets]
  );

  const allocations: MarketAllocation[] = [];
  for (const r of rows) {
    const n = Number(r.n);
    const noVigClv = r.avg_no_vig_clv == null ? null : Number(r.avg_no_vig_clv);
    const clv = r.avg_clv == null ? 0 : Number(r.avg_clv);
    const stake = Number(r.total_stake) || 1;
    const payout = Number(r.total_payout) || 0;
    const roi = ((payout - stake) / stake) * 100;

    // Prefer no-vig CLV if available; fall back to juiced CLV.
    const driver = noVigClv != null ? noVigClv : clv * 0.5; // discount juiced CLV ~50%
    let kelly = 0.25;
    let alloc = 5; // % of bankroll cap on this cluster
    let rationale: string;
    if (driver >= 1) {
      kelly = 0.30;
      alloc = 8;
      rationale = `Strong +CLV cluster (${driver.toFixed(2)}% over ${n} bets). Boosted to 0.30 Kelly.`;
    } else if (driver >= 0.25) {
      kelly = 0.25;
      alloc = 5;
      rationale = `Acceptable +CLV (${driver.toFixed(2)}%). Default 0.25 Kelly.`;
    } else if (driver > -0.5) {
      kelly = 0.10;
      alloc = 2;
      rationale = `Marginal CLV (${driver.toFixed(2)}%). Haircut to 0.10 Kelly.`;
    } else {
      kelly = 0;
      alloc = 0;
      rationale = `Negative CLV (${driver.toFixed(2)}% over ${n} bets). DO NOT BET this cluster.`;
    }

    allocations.push({
      sport: r.sport,
      bet_type: r.bet_type,
      book: r.book,
      bets: n,
      avg_no_vig_clv_pct: noVigClv ?? 0,
      avg_clv_pct: clv,
      roi_pct: Number(roi.toFixed(2)),
      recommended_kelly_fraction: kelly,
      recommended_allocation_pct: alloc,
      basis: noVigClv != null ? "auto_no_vig_clv" : "auto_clv",
      rationale,
    });

    // Persist
    await query(
      `INSERT INTO market_bankroll_allocations
         (sport, bet_type, book, allocation_pct, kelly_fraction, basis, basis_metric, basis_n)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (sport, bet_type, book) DO UPDATE SET
         allocation_pct = EXCLUDED.allocation_pct,
         kelly_fraction = EXCLUDED.kelly_fraction,
         basis = EXCLUDED.basis,
         basis_metric = EXCLUDED.basis_metric,
         basis_n = EXCLUDED.basis_n,
         computed_at = NOW()`,
      [r.sport, r.bet_type, r.book, alloc, kelly, allocations[allocations.length - 1].basis, driver, n]
    );
  }

  if (allocations.length === 0) {
    notes.push(`No clusters with ≥${minBets} settled bets in the last ${lookback} days. Allocations unchanged.`);
  }

  allocations.sort((a, b) => b.recommended_kelly_fraction - a.recommended_kelly_fraction);

  return { action, allocations, notes };
}

/**
 * Resolve the recommended Kelly fraction for a given (sport, bet_type, book) cluster.
 * Returns 0.25 by default if no override exists.
 */
export async function resolveKellyFraction(params: {
  sport: string;
  bet_type: string;
  book?: string;
}): Promise<{ kelly_fraction: number; allocation_pct: number; basis: string; sourced_from_db: boolean }> {
  if (!isDatabaseConfigured()) {
    return { kelly_fraction: 0.25, allocation_pct: 5, basis: "default_no_db", sourced_from_db: false };
  }
  try {
    const rows = await query<{
      kelly_fraction: string | number;
      allocation_pct: string | number;
      basis: string;
    }>(
      `SELECT kelly_fraction, allocation_pct, basis
         FROM market_bankroll_allocations
        WHERE sport = $1 AND bet_type = $2 AND (book = $3 OR (book IS NULL AND $3 IS NULL))
        ORDER BY (book IS NOT NULL) DESC
        LIMIT 1`,
      [params.sport, params.bet_type, params.book ?? null]
    );
    if (rows.length === 0) {
      return { kelly_fraction: 0.25, allocation_pct: 5, basis: "default_no_override", sourced_from_db: false };
    }
    return {
      kelly_fraction: Number(rows[0].kelly_fraction),
      allocation_pct: Number(rows[0].allocation_pct),
      basis: rows[0].basis,
      sourced_from_db: true,
    };
  } catch (err) {
    console.error("[MarketBankroll] resolveKellyFraction failed:", err);
    return { kelly_fraction: 0.25, allocation_pct: 5, basis: "default_error", sourced_from_db: false };
  }
}
