/**
 * Performance Analysis — queries bet history to surface ROI patterns.
 */

import { isDatabaseConfigured, query, queryOne } from "../../db/client.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface PerformanceFilters {
  sport?: string;
  bet_type?: string;
  date_from?: string;
  date_to?: string;
  min_bets?: number;
}

export interface PerformanceReport {
  total_bets: number;
  total_stake: number;
  total_payout: number;
  roi_pct: number;
  win_rate_pct: number;
  avg_clv: number;
  by_sport: BreakdownRow[];
  by_bet_type: BreakdownRow[];
  by_book: BreakdownRow[];
  best_conditions: ConditionCluster[];
  worst_conditions: ConditionCluster[];
  filters_applied: PerformanceFilters;
}

export interface BreakdownRow {
  label: string;
  bets: number;
  wins: number;
  win_rate_pct: number;
  total_stake: number;
  total_payout: number;
  roi_pct: number;
  avg_clv: number;
}

export interface ConditionCluster {
  description: string;
  bets: number;
  roi_pct: number;
  avg_clv: number;
}

// ── Implementation ───────────────────────────────────────────────────────────

export async function analyzePerformance(
  filters: PerformanceFilters
): Promise<PerformanceReport> {
  if (!isDatabaseConfigured()) {
    throw new Error(
      "DATABASE_URL not configured. Performance analysis requires Postgres with logged bets."
    );
  }

  // Check performance_cache first (valid for 24 hours)
  const cacheKey = buildCacheKey(filters);
  const cached = await queryOne<{ result_json: PerformanceReport; computed_at: string }>(
    "SELECT result_json, computed_at FROM performance_cache WHERE filter_key = $1 AND computed_at > NOW() - INTERVAL '24 hours'",
    [cacheKey]
  );
  if (cached) {
    console.error(`[Perf] Returning cached result for ${cacheKey}`);
    return cached.result_json;
  }

  const minBets = filters.min_bets ?? 1;

  // Build WHERE clause
  const conditions: string[] = ["outcome IS NOT NULL"];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (filters.sport) {
    conditions.push(`sport = $${paramIdx++}`);
    params.push(filters.sport);
  }
  if (filters.bet_type) {
    conditions.push(`bet_type = $${paramIdx++}`);
    params.push(filters.bet_type);
  }
  if (filters.date_from) {
    conditions.push(`created_at >= $${paramIdx++}`);
    params.push(filters.date_from);
  }
  if (filters.date_to) {
    conditions.push(`created_at <= $${paramIdx++}`);
    params.push(filters.date_to);
  }

  const where = conditions.join(" AND ");

  // Overall stats
  const overall = await query<{
    total_bets: string;
    total_stake: string;
    total_payout: string;
    wins: string;
    avg_clv: string;
  }>(
    `SELECT
       COUNT(*) as total_bets,
       COALESCE(SUM(stake), 0) as total_stake,
       COALESCE(SUM(payout), 0) as total_payout,
       COUNT(*) FILTER (WHERE outcome = 'win') as wins,
       COALESCE(AVG(clv), 0) as avg_clv
     FROM bets WHERE ${where}`,
    params
  );

  const o = overall[0];
  const totalBets = parseInt(o.total_bets);
  const totalStake = parseFloat(o.total_stake);
  const totalPayout = parseFloat(o.total_payout);
  const wins = parseInt(o.wins);
  const avgClv = parseFloat(o.avg_clv);

  // By sport
  const bySport = await queryBreakdown("sport", where, params);
  const byBetType = await queryBreakdown("bet_type", where, params);
  const byBook = await queryBreakdown("book", where, params);

  // Condition clusters (sport + bet_type combos)
  const clusters = await query<{
    sport: string;
    bet_type: string;
    bets: string;
    roi: string;
    avg_clv: string;
  }>(
    `SELECT sport, bet_type,
       COUNT(*) as bets,
       CASE WHEN SUM(stake) > 0 THEN ((SUM(payout) - SUM(stake)) / SUM(stake) * 100) ELSE 0 END as roi,
       COALESCE(AVG(clv), 0) as avg_clv
     FROM bets WHERE ${where}
     GROUP BY sport, bet_type
     HAVING COUNT(*) >= $${paramIdx}
     ORDER BY roi DESC`,
    [...params, minBets]
  );

  const bestConditions = clusters.slice(0, 5).map((c) => ({
    description: `${c.sport} / ${c.bet_type}`,
    bets: parseInt(c.bets),
    roi_pct: parseFloat(c.roi),
    avg_clv: parseFloat(c.avg_clv),
  }));

  const worstConditions = clusters
    .slice(-5)
    .reverse()
    .map((c) => ({
      description: `${c.sport} / ${c.bet_type}`,
      bets: parseInt(c.bets),
      roi_pct: parseFloat(c.roi),
      avg_clv: parseFloat(c.avg_clv),
    }));

  const report: PerformanceReport = {
    total_bets: totalBets,
    total_stake: totalStake,
    total_payout: totalPayout,
    roi_pct:
      totalStake > 0
        ? Math.round(((totalPayout - totalStake) / totalStake) * 10000) / 100
        : 0,
    win_rate_pct:
      totalBets > 0 ? Math.round((wins / totalBets) * 10000) / 100 : 0,
    avg_clv: Math.round(avgClv * 1000) / 1000,
    by_sport: bySport,
    by_bet_type: byBetType,
    by_book: byBook,
    best_conditions: bestConditions,
    worst_conditions: worstConditions,
    filters_applied: filters,
  };

  // Store in performance_cache for 24-hour reuse
  await query(
    `INSERT INTO performance_cache (filter_key, result_json)
     VALUES ($1, $2)
     ON CONFLICT (filter_key) DO UPDATE SET result_json = $2, computed_at = NOW()`,
    [cacheKey, JSON.stringify(report)]
  ).catch((err) => console.error("[Perf] Cache write failed:", err));

  return report;
}

function buildCacheKey(filters: PerformanceFilters): string {
  return [
    filters.sport ?? "all",
    filters.bet_type ?? "all",
    filters.date_from ?? "start",
    filters.date_to ?? "now",
    String(filters.min_bets ?? 1),
  ].join("|");
}

async function queryBreakdown(
  groupCol: string,
  where: string,
  params: unknown[]
): Promise<BreakdownRow[]> {
  const rows = await query<{
    label: string;
    bets: string;
    wins: string;
    total_stake: string;
    total_payout: string;
    avg_clv: string;
  }>(
    `SELECT
       ${groupCol} as label,
       COUNT(*) as bets,
       COUNT(*) FILTER (WHERE outcome = 'win') as wins,
       COALESCE(SUM(stake), 0) as total_stake,
       COALESCE(SUM(payout), 0) as total_payout,
       COALESCE(AVG(clv), 0) as avg_clv
     FROM bets WHERE ${where}
     GROUP BY ${groupCol}
     ORDER BY COUNT(*) DESC`,
    params
  );

  return rows.map((r) => {
    const bets = parseInt(r.bets);
    const wins = parseInt(r.wins);
    const stake = parseFloat(r.total_stake);
    const payout = parseFloat(r.total_payout);
    return {
      label: r.label,
      bets,
      wins,
      win_rate_pct: bets > 0 ? Math.round((wins / bets) * 10000) / 100 : 0,
      total_stake: stake,
      total_payout: payout,
      roi_pct:
        stake > 0 ? Math.round(((payout - stake) / stake) * 10000) / 100 : 0,
      avg_clv: parseFloat(r.avg_clv),
    };
  });
}
