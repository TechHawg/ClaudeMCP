/**
 * CLV Leaderboard — ranks your bets by closing line value.
 * Identifies which bet types, sports, and books consistently produce +CLV.
 */

import { isDatabaseConfigured, query } from "../../db/client.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface CLVLeaderboardEntry {
  rank: number;
  category: string;
  value: string;
  total_bets: number;
  avg_clv: number;
  positive_clv_pct: number;
  total_profit: number;
  roi_pct: number;
}

export interface CLVLeaderboardResult {
  by_sport: CLVLeaderboardEntry[];
  by_bet_type: CLVLeaderboardEntry[];
  by_book: CLVLeaderboardEntry[];
  top_bets: {
    bet_id: number;
    game: string;
    side: string;
    odds: number;
    closing_line: number;
    clv: number;
    outcome: string;
  }[];
  summary: {
    total_bets_with_clv: number;
    avg_clv: number;
    positive_clv_pct: number;
    clv_vs_results_correlation: string;
  };
  generated_at: string;
}

// ── Implementation ───────────────────────────────────────────────────────────

export async function getCLVLeaderboard(params: {
  group_by?: string; // "sport" | "bet_type" | "book" | "all"
  days?: number; // lookback period (default 30)
  min_bets?: number; // minimum bets to include category (default 3)
}): Promise<CLVLeaderboardResult> {
  if (!isDatabaseConfigured()) {
    return {
      by_sport: [],
      by_bet_type: [],
      by_book: [],
      top_bets: [],
      summary: {
        total_bets_with_clv: 0,
        avg_clv: 0,
        positive_clv_pct: 0,
        clv_vs_results_correlation: "Database not configured — CLV leaderboard requires DATABASE_URL.",
      },
      generated_at: new Date().toISOString(),
    };
  }

  const days = params.days ?? 30;
  const minBets = params.min_bets ?? 3;
  const groupBy = params.group_by ?? "all";

  const result: CLVLeaderboardResult = {
    by_sport: [],
    by_bet_type: [],
    by_book: [],
    top_bets: [],
    summary: {
      total_bets_with_clv: 0,
      avg_clv: 0,
      positive_clv_pct: 0,
      clv_vs_results_correlation: "",
    },
    generated_at: new Date().toISOString(),
  };

  // Overall summary
  const summaryRows = await query<{
    total: string;
    avg_clv: string;
    pos_pct: string;
  }>(
    `SELECT
       COUNT(*) as total,
       COALESCE(AVG(clv), 0) as avg_clv,
       COALESCE(
         ROUND(100.0 * COUNT(*) FILTER (WHERE clv > 0) / NULLIF(COUNT(*), 0), 1),
         0
       ) as pos_pct
     FROM bets
     WHERE clv IS NOT NULL AND created_at >= NOW() - INTERVAL '1 day' * $1`,
    [days]
  );

  if (summaryRows[0]) {
    result.summary.total_bets_with_clv = parseInt(summaryRows[0].total);
    result.summary.avg_clv = parseFloat(summaryRows[0].avg_clv);
    result.summary.positive_clv_pct = parseFloat(summaryRows[0].pos_pct);
  }

  // CLV vs Results correlation check
  const corrRows = await query<{ win_avg_clv: string; loss_avg_clv: string }>(
    `SELECT
       COALESCE(AVG(clv) FILTER (WHERE outcome = 'win'), 0) as win_avg_clv,
       COALESCE(AVG(clv) FILTER (WHERE outcome = 'loss'), 0) as loss_avg_clv
     FROM bets
     WHERE clv IS NOT NULL AND outcome IS NOT NULL AND created_at >= NOW() - INTERVAL '1 day' * $1`,
    [days]
  );

  if (corrRows[0]) {
    const winClv = parseFloat(corrRows[0].win_avg_clv);
    const lossClv = parseFloat(corrRows[0].loss_avg_clv);
    if (winClv > lossClv) {
      result.summary.clv_vs_results_correlation = `Positive CLV predicts wins: winning bets avg CLV ${winClv.toFixed(2)}% vs losing bets ${lossClv.toFixed(2)}%. Your CLV is a reliable edge indicator.`;
    } else {
      result.summary.clv_vs_results_correlation = `CLV-results divergence: winning bets avg CLV ${winClv.toFixed(2)}% vs losing bets ${lossClv.toFixed(2)}%. Sample may be too small or variance is high.`;
    }
  }

  // By Sport
  if (groupBy === "all" || groupBy === "sport") {
    const sportRows = await query<{
      sport: string;
      total: string;
      avg_clv: string;
      pos_pct: string;
      profit: string;
      roi: string;
    }>(
      `SELECT sport,
              COUNT(*) as total,
              ROUND(AVG(clv)::numeric, 3) as avg_clv,
              ROUND(100.0 * COUNT(*) FILTER (WHERE clv > 0) / NULLIF(COUNT(*), 0), 1) as pos_pct,
              COALESCE(SUM(CASE WHEN outcome = 'win' THEN payout - stake WHEN outcome = 'loss' THEN -stake ELSE 0 END), 0) as profit,
              CASE WHEN SUM(stake) > 0
                THEN ROUND(100.0 * SUM(CASE WHEN outcome = 'win' THEN payout - stake WHEN outcome = 'loss' THEN -stake ELSE 0 END) / SUM(stake), 2)
                ELSE 0 END as roi
       FROM bets
       WHERE clv IS NOT NULL AND created_at >= NOW() - INTERVAL '1 day' * $1
       GROUP BY sport
       HAVING COUNT(*) >= $2
       ORDER BY AVG(clv) DESC`,
      [days, minBets]
    );
    result.by_sport = sportRows.map((r, i) => ({
      rank: i + 1,
      category: "sport",
      value: r.sport,
      total_bets: parseInt(r.total),
      avg_clv: parseFloat(r.avg_clv),
      positive_clv_pct: parseFloat(r.pos_pct),
      total_profit: parseFloat(r.profit),
      roi_pct: parseFloat(r.roi),
    }));
  }

  // By Bet Type
  if (groupBy === "all" || groupBy === "bet_type") {
    const typeRows = await query<{
      bet_type: string;
      total: string;
      avg_clv: string;
      pos_pct: string;
      profit: string;
      roi: string;
    }>(
      `SELECT bet_type,
              COUNT(*) as total,
              ROUND(AVG(clv)::numeric, 3) as avg_clv,
              ROUND(100.0 * COUNT(*) FILTER (WHERE clv > 0) / NULLIF(COUNT(*), 0), 1) as pos_pct,
              COALESCE(SUM(CASE WHEN outcome = 'win' THEN payout - stake WHEN outcome = 'loss' THEN -stake ELSE 0 END), 0) as profit,
              CASE WHEN SUM(stake) > 0
                THEN ROUND(100.0 * SUM(CASE WHEN outcome = 'win' THEN payout - stake WHEN outcome = 'loss' THEN -stake ELSE 0 END) / SUM(stake), 2)
                ELSE 0 END as roi
       FROM bets
       WHERE clv IS NOT NULL AND created_at >= NOW() - INTERVAL '1 day' * $1
       GROUP BY bet_type
       HAVING COUNT(*) >= $2
       ORDER BY AVG(clv) DESC`,
      [days, minBets]
    );
    result.by_bet_type = typeRows.map((r, i) => ({
      rank: i + 1,
      category: "bet_type",
      value: r.bet_type,
      total_bets: parseInt(r.total),
      avg_clv: parseFloat(r.avg_clv),
      positive_clv_pct: parseFloat(r.pos_pct),
      total_profit: parseFloat(r.profit),
      roi_pct: parseFloat(r.roi),
    }));
  }

  // By Book
  if (groupBy === "all" || groupBy === "book") {
    const bookRows = await query<{
      book: string;
      total: string;
      avg_clv: string;
      pos_pct: string;
      profit: string;
      roi: string;
    }>(
      `SELECT book,
              COUNT(*) as total,
              ROUND(AVG(clv)::numeric, 3) as avg_clv,
              ROUND(100.0 * COUNT(*) FILTER (WHERE clv > 0) / NULLIF(COUNT(*), 0), 1) as pos_pct,
              COALESCE(SUM(CASE WHEN outcome = 'win' THEN payout - stake WHEN outcome = 'loss' THEN -stake ELSE 0 END), 0) as profit,
              CASE WHEN SUM(stake) > 0
                THEN ROUND(100.0 * SUM(CASE WHEN outcome = 'win' THEN payout - stake WHEN outcome = 'loss' THEN -stake ELSE 0 END) / SUM(stake), 2)
                ELSE 0 END as roi
       FROM bets
       WHERE clv IS NOT NULL AND created_at >= NOW() - INTERVAL '1 day' * $1
       GROUP BY book
       HAVING COUNT(*) >= $2
       ORDER BY AVG(clv) DESC`,
      [days, minBets]
    );
    result.by_book = bookRows.map((r, i) => ({
      rank: i + 1,
      category: "book",
      value: r.book,
      total_bets: parseInt(r.total),
      avg_clv: parseFloat(r.avg_clv),
      positive_clv_pct: parseFloat(r.pos_pct),
      total_profit: parseFloat(r.profit),
      roi_pct: parseFloat(r.roi),
    }));
  }

  // Top individual bets by CLV
  const topRows = await query<{
    id: number;
    game: string;
    side: string;
    odds: number;
    closing_line: number;
    clv: number;
    outcome: string;
  }>(
    `SELECT id, game, side, odds, closing_line, clv, outcome
     FROM bets
     WHERE clv IS NOT NULL AND created_at >= NOW() - INTERVAL '1 day' * $1
     ORDER BY clv DESC
     LIMIT 10`,
    [days]
  );
  result.top_bets = topRows.map((r) => ({
    bet_id: r.id,
    game: r.game,
    side: r.side,
    odds: r.odds,
    closing_line: r.closing_line,
    clv: r.clv,
    outcome: r.outcome ?? "pending",
  }));

  return result;
}
