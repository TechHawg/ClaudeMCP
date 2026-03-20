/**
 * Edge Identification — clusters bets by conditions and finds profitable patterns.
 */

import { isDatabaseConfigured, query } from "../../db/client.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface EdgeCluster {
  rank: number;
  conditions: string;
  sport: string;
  bet_type: string;
  sample_size: number;
  roi_pct: number;
  avg_clv: number;
  win_rate_pct: number;
  avg_edge_pct: number;
  avg_confidence: number;
  insight: string;
}

export interface EdgeReport {
  top_edges: EdgeCluster[];
  total_bets_analyzed: number;
  min_sample_size: number;
  message: string;
}

// ── Implementation ───────────────────────────────────────────────────────────

export async function identifyEdges(params?: {
  min_sample_size?: number;
}): Promise<EdgeReport> {
  if (!isDatabaseConfigured()) {
    throw new Error(
      "DATABASE_URL not configured. Edge identification requires Postgres with logged bets."
    );
  }

  const minSample = params?.min_sample_size ?? 20;

  // Count total bets with outcomes
  const countResult = await query<{ count: string }>(
    "SELECT COUNT(*) as count FROM bets WHERE outcome IS NOT NULL"
  );
  const totalBets = parseInt(countResult[0]?.count ?? "0");

  if (totalBets < minSample) {
    return {
      top_edges: [],
      total_bets_analyzed: totalBets,
      min_sample_size: minSample,
      message: `Not enough data yet. You have ${totalBets} completed bets — need at least ${minSample} for edge identification.`,
    };
  }

  // Cluster by sport + bet_type + book
  const clusters = await query<{
    sport: string;
    bet_type: string;
    book: string;
    bets: string;
    wins: string;
    total_stake: string;
    total_payout: string;
    avg_clv: string;
    avg_edge: string;
    avg_confidence: string;
  }>(
    `SELECT
       sport, bet_type, book,
       COUNT(*) as bets,
       COUNT(*) FILTER (WHERE outcome = 'win') as wins,
       COALESCE(SUM(stake), 0) as total_stake,
       COALESCE(SUM(payout), 0) as total_payout,
       COALESCE(AVG(clv), 0) as avg_clv,
       COALESCE(AVG(edge_pct), 0) as avg_edge,
       COALESCE(AVG(confidence_score), 0) as avg_confidence
     FROM bets
     WHERE outcome IS NOT NULL
     GROUP BY sport, bet_type, book
     HAVING COUNT(*) >= $1
     ORDER BY ((SUM(payout) - SUM(stake)) / NULLIF(SUM(stake), 0) * 100) DESC
     LIMIT 10`,
    [minSample]
  );

  const topEdges: EdgeCluster[] = clusters.map((c, i) => {
    const bets = parseInt(c.bets);
    const wins = parseInt(c.wins);
    const stake = parseFloat(c.total_stake);
    const payout = parseFloat(c.total_payout);
    const roi = stake > 0 ? ((payout - stake) / stake) * 100 : 0;
    const winRate = bets > 0 ? (wins / bets) * 100 : 0;
    const avgClv = parseFloat(c.avg_clv);

    let insight = "";
    if (roi > 5 && avgClv > 0) {
      insight = `Strong edge: +${roi.toFixed(1)}% ROI with positive CLV — this is a sustainable, skill-based edge.`;
    } else if (roi > 5 && avgClv <= 0) {
      insight = `Profitable but no CLV — could be variance. Monitor over more bets before increasing stake.`;
    } else if (roi <= 0 && avgClv > 0) {
      insight = `Positive CLV but negative ROI — likely just variance on a small sample. Keep betting this spot.`;
    } else {
      insight = `Negative ROI and CLV — consider reducing or eliminating bets in this category.`;
    }

    return {
      rank: i + 1,
      conditions: `${c.sport} / ${c.bet_type} / ${c.book}`,
      sport: c.sport,
      bet_type: c.bet_type,
      sample_size: bets,
      roi_pct: Math.round(roi * 100) / 100,
      avg_clv: Math.round(avgClv * 1000) / 1000,
      win_rate_pct: Math.round(winRate * 100) / 100,
      avg_edge_pct: parseFloat(c.avg_edge),
      avg_confidence: parseFloat(c.avg_confidence),
      insight,
    };
  });

  return {
    top_edges: topEdges.slice(0, 5),
    total_bets_analyzed: totalBets,
    min_sample_size: minSample,
    message:
      topEdges.length > 0
        ? `Found ${topEdges.length} edge clusters with ${minSample}+ bets. Focus on your top-performing conditions.`
        : `No clusters found with ${minSample}+ bets yet. Keep logging bets and check back.`,
  };
}
