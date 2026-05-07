/**
 * Confidence Scorer — scores proposed bets 1-10.
 *
 * Critical change: this used to be a pure heuristic with arbitrary weights.
 * It now also queries the bet log automatically for the (sport, bet_type, book)
 * cluster's rolling CLV and ROI, so historical performance enters the score
 * without the caller having to remember to pass `historical_roi_for_type`.
 *
 * Every contribution carries a `data_quality` so callers can see which signals
 * are real measurements vs heuristics vs missing.
 */

import {
  isDatabaseConfigured,
  query,
} from "../../db/client.js";
import type { DataQuality } from "../../utils/helpers.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ConfidenceInput {
  sport: string;
  game: string;
  side: string;
  bet_type: string;
  odds: number;
  book?: string;
  edge_pct?: number;
  /** Set to true if `edge_pct` was computed from no-vig consensus (not raw Pinnacle). */
  edge_is_no_vig?: boolean;
  sharp_pct?: number;
  /** "real" if from ActionNetwork, "inferred" if from line-divergence heuristic. */
  sharp_data_quality?: DataQuality;
  line_movement_favorable?: boolean;
  reverse_line_movement?: boolean;
  steam_move?: boolean;
  /** Pinnacle drift in last 60 minutes (positive = sharp money is on YOUR side). */
  pinnacle_drift_pct?: number;
  situational_angles_matched?: number;
  /** Set true if matched angles all have sample_size ≥ 50 and historical_roi > 0. */
  situational_angles_validated?: boolean;
  weather_impact?: "none" | "favorable" | "unfavorable";
  injury_advantage?: boolean;
  data_completeness?: number; // 0-100
  historical_roi_for_type?: number;
  /** Skip DB lookups (for unit tests). */
  skip_db_lookup?: boolean;
}

export interface ConfidenceResult {
  score: number; // 1-10
  grade: string; // A+ through F
  breakdown: ConfidenceBreakdownItem[];
  recommendation: string;
  /** Hard reject regardless of score (e.g., negative cluster CLV). */
  hard_reject: boolean;
  hard_reject_reason?: string;
  cluster_stats?: ClusterStats;
}

export interface ConfidenceBreakdownItem {
  signal: string;
  value: string;
  contribution: number;
  status: "positive" | "negative" | "neutral" | "missing";
  data_quality: DataQuality;
}

export interface ClusterStats {
  cluster: string;
  bets: number;
  win_rate_pct: number;
  roi_pct: number;
  avg_clv_pct: number;
}

// ── Implementation ───────────────────────────────────────────────────────────

export async function getConfidenceScore(
  input: ConfidenceInput
): Promise<ConfidenceResult> {
  const breakdown: ConfidenceBreakdownItem[] = [];
  let score = 5; // neutral start

  // 1. Statistical edge
  if (input.edge_pct != null) {
    const isNoVig = !!input.edge_is_no_vig;
    const dq: DataQuality = isNoVig ? "real" : "inferred";
    if (input.edge_pct >= 5) {
      score += isNoVig ? 2 : 1.25;
      breakdown.push({
        signal: isNoVig ? "No-Vig Edge" : "Edge (raw, juice not stripped)",
        value: `${input.edge_pct.toFixed(2)}%`,
        contribution: isNoVig ? 2 : 1.25,
        status: "positive",
        data_quality: dq,
      });
    } else if (input.edge_pct >= 1.5) {
      score += isNoVig ? 1 : 0.5;
      breakdown.push({
        signal: isNoVig ? "No-Vig Edge" : "Edge (raw)",
        value: `${input.edge_pct.toFixed(2)}%`,
        contribution: isNoVig ? 1 : 0.5,
        status: "positive",
        data_quality: dq,
      });
    } else if (input.edge_pct < 0) {
      score -= 1.5;
      breakdown.push({
        signal: "Edge",
        value: `${input.edge_pct.toFixed(2)}% (negative)`,
        contribution: -1.5,
        status: "negative",
        data_quality: dq,
      });
    }
  } else {
    score -= 0.5;
    breakdown.push({
      signal: "Edge",
      value: "Not calculated",
      contribution: -0.5,
      status: "missing",
      data_quality: "missing",
    });
  }

  // 2. Sharp money — weight depends on data quality
  if (input.sharp_pct != null) {
    const dq = input.sharp_data_quality ?? "inferred";
    const weight = dq === "real" ? 1.5 : 0.6;
    if (input.sharp_pct >= 60) {
      score += weight;
      breakdown.push({
        signal: "Sharp Money",
        value: `${input.sharp_pct}% (${dq})`,
        contribution: weight,
        status: "positive",
        data_quality: dq,
      });
    } else if (input.sharp_pct <= 40) {
      score -= weight;
      breakdown.push({
        signal: "Sharp Money",
        value: `${input.sharp_pct}% against you (${dq})`,
        contribution: -weight,
        status: "negative",
        data_quality: dq,
      });
    }
  } else {
    breakdown.push({
      signal: "Sharp Money",
      value: "No data",
      contribution: -0.25,
      status: "missing",
      data_quality: "missing",
    });
    score -= 0.25;
  }

  // 3. Line movement / RLM
  if (input.reverse_line_movement) {
    score += 1.5;
    breakdown.push({
      signal: "Reverse Line Movement",
      value: "Detected",
      contribution: 1.5,
      status: "positive",
      data_quality: "real",
    });
  } else if (input.line_movement_favorable) {
    score += 0.5;
    breakdown.push({
      signal: "Line Movement",
      value: "Favorable",
      contribution: 0.5,
      status: "positive",
      data_quality: "real",
    });
  }

  // 4. Pinnacle drift in your favor (last hour)
  if (input.pinnacle_drift_pct != null) {
    if (input.pinnacle_drift_pct >= 1.5) {
      score += 1;
      breakdown.push({
        signal: "Pinnacle Drift",
        value: `+${input.pinnacle_drift_pct.toFixed(2)}% toward your side`,
        contribution: 1,
        status: "positive",
        data_quality: "real",
      });
    } else if (input.pinnacle_drift_pct <= -1.5) {
      score -= 1.5;
      breakdown.push({
        signal: "Pinnacle Drift",
        value: `${input.pinnacle_drift_pct.toFixed(2)}% away from your side — sharp money is moving against you`,
        contribution: -1.5,
        status: "negative",
        data_quality: "real",
      });
    }
  }

  // 5. Steam move
  if (input.steam_move) {
    score += 1;
    breakdown.push({
      signal: "Steam Move",
      value: "Active",
      contribution: 1,
      status: "positive",
      data_quality: "real",
    });
  }

  // 6. Situational angles — only count if validated
  if (input.situational_angles_matched != null && input.situational_angles_matched > 0) {
    const validated = !!input.situational_angles_validated;
    const contrib = validated ? 0.5 * input.situational_angles_matched : 0.15 * input.situational_angles_matched;
    score += Math.min(contrib, 1.5);
    breakdown.push({
      signal: "Situational Angles",
      value: `${input.situational_angles_matched} matched${validated ? " (validated, n≥50)" : " (unvalidated priors)"}`,
      contribution: Math.min(contrib, 1.5),
      status: "positive",
      data_quality: validated ? "real" : "prior",
    });
  }

  // 7. Weather
  if (input.weather_impact === "favorable") {
    score += 0.5;
    breakdown.push({
      signal: "Weather",
      value: "Favorable",
      contribution: 0.5,
      status: "positive",
      data_quality: "real",
    });
  } else if (input.weather_impact === "unfavorable") {
    score -= 1;
    breakdown.push({
      signal: "Weather",
      value: "Unfavorable",
      contribution: -1,
      status: "negative",
      data_quality: "real",
    });
  }

  // 8. Injury advantage
  if (input.injury_advantage) {
    score += 0.5;
    breakdown.push({
      signal: "Injury Edge",
      value: "Detected",
      contribution: 0.5,
      status: "positive",
      data_quality: "real",
    });
  }

  // 9. Data completeness
  if (input.data_completeness != null) {
    if (input.data_completeness < 50) {
      score -= 1;
      breakdown.push({
        signal: "Data Completeness",
        value: `${input.data_completeness}%`,
        contribution: -1,
        status: "negative",
        data_quality: "real",
      });
    } else if (input.data_completeness < 75) {
      score -= 0.5;
      breakdown.push({
        signal: "Data Completeness",
        value: `${input.data_completeness}%`,
        contribution: -0.5,
        status: "negative",
        data_quality: "real",
      });
    }
  }

  // 10. Historical performance — auto-fetched from DB if not supplied
  let cluster_stats: ClusterStats | undefined;
  let hard_reject = false;
  let hard_reject_reason: string | undefined;

  let historicalRoi = input.historical_roi_for_type;
  if (historicalRoi == null && !input.skip_db_lookup) {
    const stats = await loadClusterStats(input.sport, input.bet_type, input.book);
    if (stats) {
      cluster_stats = stats;
      historicalRoi = stats.roi_pct;
      // HARD REJECT: cluster has ≥30 settled bets and CLV < -1%.
      // This is the closed-loop guard — Claude won't keep recommending in
      // markets where the user has demonstrated negative CLV.
      if (stats.bets >= 30 && stats.avg_clv_pct < -1) {
        hard_reject = true;
        hard_reject_reason =
          `Cluster ${stats.cluster} has ${stats.bets} bets with avg CLV ${stats.avg_clv_pct.toFixed(2)}%. You're getting beat by the close consistently here — stop betting this market until you find an edge.`;
      }
    }
  }

  if (historicalRoi != null) {
    if (historicalRoi > 5) {
      score += 0.75;
      breakdown.push({
        signal: "Historical ROI",
        value: `+${historicalRoi.toFixed(1)}%`,
        contribution: 0.75,
        status: "positive",
        data_quality: cluster_stats ? "real" : "real",
      });
    } else if (historicalRoi < -5) {
      score -= 1;
      breakdown.push({
        signal: "Historical ROI",
        value: `${historicalRoi.toFixed(1)}%`,
        contribution: -1,
        status: "negative",
        data_quality: "real",
      });
    }
  }

  if (cluster_stats && cluster_stats.bets >= 20) {
    if (cluster_stats.avg_clv_pct >= 0.5) {
      score += 0.5;
      breakdown.push({
        signal: "Cluster CLV",
        value: `+${cluster_stats.avg_clv_pct.toFixed(2)}% over ${cluster_stats.bets} bets`,
        contribution: 0.5,
        status: "positive",
        data_quality: "real",
      });
    } else if (cluster_stats.avg_clv_pct < -0.5) {
      score -= 1;
      breakdown.push({
        signal: "Cluster CLV",
        value: `${cluster_stats.avg_clv_pct.toFixed(2)}% over ${cluster_stats.bets} bets`,
        contribution: -1,
        status: "negative",
        data_quality: "real",
      });
    }
  }

  // Clamp and grade
  score = Math.max(1, Math.min(10, Math.round(score * 10) / 10));
  const grade = scoreToGrade(score);
  const recommendation = generateRecommendation(score, breakdown, hard_reject);

  return {
    score,
    grade,
    breakdown,
    recommendation,
    hard_reject,
    hard_reject_reason,
    cluster_stats,
  };
}

function scoreToGrade(score: number): string {
  if (score >= 9) return "A+";
  if (score >= 8) return "A";
  if (score >= 7) return "B+";
  if (score >= 6) return "B";
  if (score >= 5) return "C";
  if (score >= 4) return "D";
  return "F";
}

function generateRecommendation(
  score: number,
  breakdown: ConfidenceBreakdownItem[],
  hardReject: boolean
): string {
  if (hardReject) {
    return "DO NOT BET. Historical CLV in this cluster is negative — your past edge here is non-existent.";
  }
  const positives = breakdown.filter((b) => b.status === "positive").length;
  const negatives = breakdown.filter((b) => b.status === "negative").length;
  const missing = breakdown.filter((b) => b.status === "missing").length;
  const realPositives = breakdown.filter((b) => b.status === "positive" && b.data_quality === "real").length;

  if (score >= 8) {
    return `Strong play (${realPositives} real-data confirming signals). Consider full quarter-Kelly.`;
  }
  if (score >= 6) {
    return `Decent play (${positives} positives, ${negatives} negatives). Use half-quarter-Kelly.`;
  }
  if (score >= 4) {
    if (missing > 2) {
      return "Insufficient data to form conviction. Gather more signals before betting.";
    }
    return "Marginal play — signals are mixed. Pass unless you have a specific reason.";
  }
  return `Avoid this bet. ${negatives} negative signals outweigh the ${positives} positives.`;
}

async function loadClusterStats(
  sport: string,
  betType: string,
  book?: string
): Promise<ClusterStats | null> {
  if (!isDatabaseConfigured()) return null;

  try {
    const params: unknown[] = [sport, betType];
    let bookFilter = "";
    if (book) {
      params.push(book);
      bookFilter = "AND book = $3";
    }
    const rows = await query<{
      n: string | number;
      wins: string | number;
      total_stake: string | number;
      total_payout: string | number;
      avg_clv: string | number | null;
    }>(
      `SELECT
         COUNT(*) AS n,
         SUM(CASE WHEN outcome = 'win' THEN 1 ELSE 0 END) AS wins,
         SUM(stake) AS total_stake,
         COALESCE(SUM(payout), 0) AS total_payout,
         AVG(clv)::float AS avg_clv
       FROM bets
       WHERE sport = $1
         AND bet_type = $2
         ${bookFilter}
         AND outcome IN ('win', 'loss', 'push')
         AND created_at > NOW() - INTERVAL '90 days'`,
      params
    );

    const r = rows[0];
    if (!r) return null;
    const n = Number(r.n);
    if (n === 0) return null;

    const wins = Number(r.wins);
    const totalStake = Number(r.total_stake) || 1;
    const totalPayout = Number(r.total_payout) || 0;
    const profit = totalPayout - totalStake;
    const roi = (profit / totalStake) * 100;
    const avgClv = r.avg_clv == null ? 0 : Number(r.avg_clv);

    return {
      cluster: `${sport} | ${betType}${book ? ` | ${book}` : ""}`,
      bets: n,
      win_rate_pct: Number(((wins / n) * 100).toFixed(2)),
      roi_pct: Number(roi.toFixed(2)),
      avg_clv_pct: Number(avgClv.toFixed(3)),
    };
  } catch (err) {
    console.error("[Confidence] cluster stats query failed:", err);
    return null;
  }
}
