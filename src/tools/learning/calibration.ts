/**
 * Edge calibration — does our predicted edge translate into realized win rate?
 *
 * Bins logged bets by predicted no-vig edge and reports the realized win rate
 * vs the implied fair win rate. A perfectly calibrated system has:
 *     realized_win_rate ≈ implied_fair_win_rate + edge_pct/100
 *
 * Systemic deviations (e.g., bets we say have 3% edge actually win at -1%) tell
 * you the edge estimator is broken — usually because vig wasn't stripped or
 * because Pinnacle isn't actually fair for that market.
 */

import { isDatabaseConfigured, query } from "../../db/client.js";
import { americanToImpliedProb } from "../../utils/helpers.js";

export interface CalibrationBin {
  edge_bin_label: string;
  bin_lower: number;
  bin_upper: number;
  bets: number;
  wins: number;
  realized_win_rate_pct: number;
  /** Win rate implied by the offered odds (with vig). */
  implied_book_win_rate_pct: number;
  /** Win rate implied by the no-vig edge: book_implied + edge_pct. */
  predicted_win_rate_pct: number;
  /** Calibration delta: realized - predicted. Negative = our edges are inflated. */
  calibration_delta_pct: number;
}

export interface CalibrationResult {
  filter: { sport?: string; bet_type?: string; lookback_days: number };
  total_bets: number;
  bins: CalibrationBin[];
  overall_realized_pct: number;
  overall_predicted_pct: number;
  overall_delta_pct: number;
  notes: string[];
}

const BINS: Array<[number, number, string]> = [
  [-Infinity, 0, "<0%"],
  [0, 1, "0-1%"],
  [1, 2, "1-2%"],
  [2, 3, "2-3%"],
  [3, 5, "3-5%"],
  [5, 10, "5-10%"],
  [10, Infinity, "10%+"],
];

export async function getCalibration(params: {
  sport?: string;
  bet_type?: string;
  lookback_days?: number;
}): Promise<CalibrationResult> {
  const lookback = params.lookback_days ?? 180;
  const notes: string[] = [];

  if (!isDatabaseConfigured()) {
    return {
      filter: { sport: params.sport, bet_type: params.bet_type, lookback_days: lookback },
      total_bets: 0,
      bins: [],
      overall_realized_pct: 0,
      overall_predicted_pct: 0,
      overall_delta_pct: 0,
      notes: ["DATABASE_URL not set — calibration requires Postgres."],
    };
  }

  const where: string[] = [
    "outcome IN ('win','loss')",
    "no_vig_edge_pct IS NOT NULL",
    `created_at > NOW() - ($1::int || ' days')::interval`,
  ];
  const args: unknown[] = [lookback];
  if (params.sport) {
    where.push(`sport = $${args.length + 1}`);
    args.push(params.sport);
  }
  if (params.bet_type) {
    where.push(`bet_type = $${args.length + 1}`);
    args.push(params.bet_type);
  }

  const rows = await query<{
    outcome: "win" | "loss";
    odds: number;
    no_vig_edge_pct: string | number;
  }>(
    `SELECT outcome, odds, no_vig_edge_pct
       FROM bets
       WHERE ${where.join(" AND ")}`,
    args
  );

  if (rows.length < 30) {
    notes.push(`Only ${rows.length} bets with no-vig edge logged — calibration needs ≥100 bets for stable estimates.`);
  }

  // Bin
  const bins: CalibrationBin[] = BINS.map(([lo, hi, label]) => ({
    edge_bin_label: label,
    bin_lower: lo,
    bin_upper: hi,
    bets: 0,
    wins: 0,
    realized_win_rate_pct: 0,
    implied_book_win_rate_pct: 0,
    predicted_win_rate_pct: 0,
    calibration_delta_pct: 0,
  }));
  const binImpliedSum = new Array(BINS.length).fill(0);

  let totalWins = 0;
  let totalImpliedSum = 0;
  let totalEdgeSum = 0;

  for (const r of rows) {
    const edge = Number(r.no_vig_edge_pct);
    const idx = BINS.findIndex(([lo, hi]) => edge >= lo && edge < hi);
    if (idx < 0) continue;
    const bin = bins[idx];
    bin.bets++;
    if (r.outcome === "win") {
      bin.wins++;
      totalWins++;
    }
    const implied = americanToImpliedProb(r.odds).toNumber() * 100;
    binImpliedSum[idx] += implied;
    totalImpliedSum += implied;
    totalEdgeSum += edge;
  }

  for (let i = 0; i < bins.length; i++) {
    const b = bins[i];
    if (b.bets === 0) continue;
    b.realized_win_rate_pct = Number(((b.wins / b.bets) * 100).toFixed(2));
    b.implied_book_win_rate_pct = Number((binImpliedSum[i] / b.bets).toFixed(2));
    // Predicted = book implied + the no-vig edge midpoint of the bin
    const midpoint = b.bin_lower === -Infinity ? -1 : b.bin_upper === Infinity ? 12.5 : (b.bin_lower + b.bin_upper) / 2;
    b.predicted_win_rate_pct = Number((b.implied_book_win_rate_pct + midpoint).toFixed(2));
    b.calibration_delta_pct = Number((b.realized_win_rate_pct - b.predicted_win_rate_pct).toFixed(2));
  }

  const total = rows.length;
  const overallRealized = total > 0 ? (totalWins / total) * 100 : 0;
  const overallImplied = total > 0 ? totalImpliedSum / total : 0;
  const overallEdge = total > 0 ? totalEdgeSum / total : 0;
  const overallPredicted = overallImplied + overallEdge;

  return {
    filter: { sport: params.sport, bet_type: params.bet_type, lookback_days: lookback },
    total_bets: total,
    bins,
    overall_realized_pct: Number(overallRealized.toFixed(2)),
    overall_predicted_pct: Number(overallPredicted.toFixed(2)),
    overall_delta_pct: Number((overallRealized - overallPredicted).toFixed(2)),
    notes,
  };
}
