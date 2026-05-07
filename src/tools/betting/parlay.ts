/**
 * Parlay Builder — correlation-aware EV with proper per-leg de-vig.
 *
 * Critical changes vs the previous version:
 *   - Per-leg "true probability" no longer multiplies by an arbitrary 0.975.
 *     Instead we expect each leg to carry a fair_prob (no-vig, ideally from
 *     value.ts / fair-odds tools). If a fair_prob isn't supplied, we still
 *     fall back to a flat haircut but flag data_quality as "inferred".
 *   - The combined "true probability" now incorporates the pairwise
 *     correlations using the binary covariance formula:
 *         P(A∩B) = P(A)P(B) + ρ_AB · σ_A · σ_B
 *     For >2 legs we sum pairwise covariances and apply the adjustment to
 *     the independent product, clamped to a valid range.
 *   - Sport detection is removed; correlations require the caller to pass
 *     `sport` (the previous version's hardcoded 12-team list silently misclassified
 *      most parlays as NBA).
 *
 * The hardcoded SPORT_CORRELATIONS table is documented as a *prior*: it should
 * be replaced over time with values measured from the user's own logged bets.
 */

import DecimalLib from "decimal.js";
const Decimal = DecimalLib.default ?? DecimalLib;
import {
  americanToDecimal,
  americanToImpliedProb,
  noVigProb2Way,
  type DataQuality,
} from "../../utils/helpers.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ParlayLeg {
  game: string;
  side: string;
  book: string;
  odds: number; // American odds offered
  point?: number;
  type: string; // "h2h" | "spread" | "total" | "prop"
  /** Optional no-vig fair probability (0-1). If supplied, used directly. */
  fair_prob?: number;
  /** Optional opposing-side American odds at the same book — used for per-leg de-vig. */
  opposing_odds?: number;
}

export interface SgpAnalysis {
  /** Decimal odds the book is offering for the SGP. */
  book_sgp_decimal_odds: number;
  book_sgp_american_odds: number;
  /** Decimal odds you'd get summing the legs as straight bets. */
  straight_combined_decimal_odds: number;
  /** Correlation-fair decimal odds (1 / true_combined_probability). */
  fair_decimal_odds: number;
  /** SGP juice = (1 / book_sgp_decimal) / true_prob - 1. Positive = book overcharging. */
  sgp_juice_pct: number;
  /** SGP price vs straight: negative means SGP is *worse* than betting legs straight. */
  sgp_vs_straight_pct: number;
  /** Recommendation: take SGP, take straight, or skip. */
  recommendation: "take_sgp" | "take_straight" | "skip";
  reasoning: string;
}

export interface CorrelationResult {
  leg_a: string;
  leg_b: string;
  correlation: number; // -1 to 1
  sample_size: number;
  data_quality: DataQuality;
  warning?: string;
  note?: string;
}

export interface LegFairOdds {
  side: string;
  book_implied_pct: number;
  fair_prob_pct: number;
  fair_source: "supplied" | "two_way_devig" | "haircut_fallback";
  data_quality: DataQuality;
}

export interface ParlayResult {
  legs: ParlayLeg[];
  leg_fair_odds: LegFairOdds[];
  combined_decimal_odds: number;
  combined_american_odds: number;
  /** Independent (uncorrelated) product of leg fair probs. */
  independent_true_probability_pct: number;
  /** Correlation-adjusted true joint probability (the metric that drives EV). */
  true_combined_probability_pct: number;
  book_implied_probability_pct: number;
  juice_percentage: number;
  /** Independent EV — what a naïve calculator would report. */
  independent_ev_percentage: number;
  /** Correlation-adjusted EV — the number that should drive bet decisions. */
  ev_percentage: number;
  correlations: CorrelationResult[];
  correlation_warnings: string[];
  recommended: boolean;
  reasoning: string;
  data_quality: DataQuality;
  notes: string[];
  /** Filled when caller passes book_sgp_american_odds for same-game legs. */
  sgp_analysis?: SgpAnalysis;
}

// ── Hardcoded correlation priors ────────────────────────────────────────────
// These are *priors* — first-order educated guesses. They should be replaced
// over time with values measured from your own logged bets via a calibration
// tool. Sample sizes here represent *prior strength*, not actual N.

interface CorrelationEntry {
  value: number;
  sampleSize: number;
  note: string;
  data_quality: DataQuality;
}

const SPORT_CORRELATIONS: Record<string, Record<string, CorrelationEntry>> = {
  nba: {
    "fav_ml+over": { value: 0.38, sampleSize: 0, note: "NBA: Favorite ML + Over — strong (high-scoring wins)", data_quality: "prior" },
    "fav_ml+under": { value: -0.28, sampleSize: 0, note: "NBA: Favorite ML + Under — negative", data_quality: "prior" },
    "dog_ml+over": { value: 0.22, sampleSize: 0, note: "NBA: Underdog ML + Over — moderate positive", data_quality: "prior" },
    "dog_ml+under": { value: 0.18, sampleSize: 0, note: "NBA: Underdog ML + Under — slight positive (defensive upset)", data_quality: "prior" },
    "fav_spread+over": { value: 0.33, sampleSize: 0, note: "NBA: Favorite spread + Over — strong", data_quality: "prior" },
    "dog_spread+under": { value: 0.22, sampleSize: 0, note: "NBA: Underdog spread + Under — moderate", data_quality: "prior" },
    "prop_over+team_win": { value: 0.38, sampleSize: 0, note: "NBA: Player Over + Team Win — strong (star drives wins)", data_quality: "prior" },
    "prop_under+team_win": { value: -0.22, sampleSize: 0, note: "NBA: Player Under + Team Win — negative", data_quality: "prior" },
    "prop_over+over": { value: 0.32, sampleSize: 0, note: "NBA: Player Over + Game Over — strong", data_quality: "prior" },
    "two_props_same_game": { value: 0.28, sampleSize: 0, note: "NBA: Two props same game — game environment effect", data_quality: "prior" },
  },
  nfl: {
    "fav_ml+over": { value: 0.30, sampleSize: 0, note: "NFL: Favorite ML + Over — moderate (less variance)", data_quality: "prior" },
    "fav_ml+under": { value: -0.20, sampleSize: 0, note: "NFL: Favorite ML + Under — slight negative", data_quality: "prior" },
    "dog_ml+over": { value: 0.15, sampleSize: 0, note: "NFL: Underdog ML + Over — weak positive", data_quality: "prior" },
    "dog_ml+under": { value: 0.12, sampleSize: 0, note: "NFL: Underdog ML + Under — slight positive", data_quality: "prior" },
    "fav_spread+over": { value: 0.28, sampleSize: 0, note: "NFL: Favorite spread + Over — moderate", data_quality: "prior" },
    "dog_spread+under": { value: 0.18, sampleSize: 0, note: "NFL: Underdog spread + Under — slight", data_quality: "prior" },
    "prop_over+team_win": { value: 0.30, sampleSize: 0, note: "NFL: Player Over + Team Win — moderate", data_quality: "prior" },
    "prop_under+team_win": { value: -0.18, sampleSize: 0, note: "NFL: Player Under + Team Win — slight negative", data_quality: "prior" },
    "prop_over+over": { value: 0.25, sampleSize: 0, note: "NFL: Player Over + Game Over — moderate", data_quality: "prior" },
    "two_props_same_game": { value: 0.22, sampleSize: 0, note: "NFL: Two props same game — moderate", data_quality: "prior" },
  },
  mlb: {
    "fav_ml+over": { value: 0.25, sampleSize: 0, note: "MLB: Favorite ML + Over — moderate", data_quality: "prior" },
    "fav_ml+under": { value: -0.15, sampleSize: 0, note: "MLB: Favorite ML + Under — slight negative", data_quality: "prior" },
    "dog_ml+over": { value: 0.18, sampleSize: 0, note: "MLB: Underdog ML + Over — slight positive", data_quality: "prior" },
    "dog_ml+under": { value: 0.10, sampleSize: 0, note: "MLB: Underdog ML + Under — weak", data_quality: "prior" },
    "fav_spread+over": { value: 0.22, sampleSize: 0, note: "MLB: Favorite RL + Over — moderate", data_quality: "prior" },
    "dog_spread+under": { value: 0.15, sampleSize: 0, note: "MLB: Underdog RL + Under — slight", data_quality: "prior" },
    "prop_over+team_win": { value: 0.32, sampleSize: 0, note: "MLB: Batter Over + Team Win — strong", data_quality: "prior" },
    "prop_under+team_win": { value: -0.25, sampleSize: 0, note: "MLB: Pitcher K's Under + Team Win — negative", data_quality: "prior" },
    "prop_over+over": { value: 0.28, sampleSize: 0, note: "MLB: Batter Over + Game Over — moderate", data_quality: "prior" },
    "two_props_same_game": { value: 0.20, sampleSize: 0, note: "MLB: Two props same game — moderate (weather-dependent)", data_quality: "prior" },
  },
  nhl: {
    "fav_ml+over": { value: 0.32, sampleSize: 0, note: "NHL: Favorite ML + Over — moderate-strong", data_quality: "prior" },
    "fav_ml+under": { value: -0.25, sampleSize: 0, note: "NHL: Favorite ML + Under — negative", data_quality: "prior" },
    "dog_ml+over": { value: 0.20, sampleSize: 0, note: "NHL: Underdog ML + Over — moderate", data_quality: "prior" },
    "dog_ml+under": { value: 0.15, sampleSize: 0, note: "NHL: Underdog ML + Under — slight", data_quality: "prior" },
    "fav_spread+over": { value: 0.30, sampleSize: 0, note: "NHL: Favorite PL + Over — moderate", data_quality: "prior" },
    "dog_spread+under": { value: 0.20, sampleSize: 0, note: "NHL: Underdog PL + Under — moderate", data_quality: "prior" },
    "prop_over+team_win": { value: 0.35, sampleSize: 0, note: "NHL: Player Over + Team Win — strong", data_quality: "prior" },
    "prop_under+team_win": { value: -0.20, sampleSize: 0, note: "NHL: Player Under + Team Win — negative", data_quality: "prior" },
    "prop_over+over": { value: 0.30, sampleSize: 0, note: "NHL: Player Over + Game Over — moderate", data_quality: "prior" },
    "two_props_same_game": { value: 0.25, sampleSize: 0, note: "NHL: Two props same game — moderate", data_quality: "prior" },
  },
};

// ── Implementation ───────────────────────────────────────────────────────────

export function buildParlay(params: {
  legs: ParlayLeg[];
  books?: string[];
  sport?: string;
  /**
   * If you're evaluating an SGP quote, pass the book's offered American odds for
   * the SGP. The result will include sgp_analysis comparing book SGP price vs
   * correlation-fair price vs the straight-leg-product price.
   */
  book_sgp_american_odds?: number;
}): ParlayResult {
  const { legs, sport } = params;

  if (legs.length < 2) {
    throw new Error("A parlay requires at least 2 legs.");
  }
  if (legs.length > 15) {
    throw new Error("Maximum 15 legs per parlay.");
  }

  const notes: string[] = [];

  // Compute combined book odds and per-leg fair probabilities.
  let combinedDecimal = new Decimal(1);
  const fairProbs: number[] = [];
  const legFairOdds: LegFairOdds[] = [];
  let anyInferred = false;

  for (const leg of legs) {
    const dec = americanToDecimal(leg.odds);
    combinedDecimal = combinedDecimal.times(dec);

    const bookProb = americanToImpliedProb(leg.odds).toNumber();

    let fairProb: number;
    let source: LegFairOdds["fair_source"];
    let dq: DataQuality;

    if (leg.fair_prob != null && leg.fair_prob > 0 && leg.fair_prob < 1) {
      fairProb = leg.fair_prob;
      source = "supplied";
      dq = "real";
    } else if (leg.opposing_odds != null) {
      fairProb = noVigProb2Way(leg.odds, leg.opposing_odds).toNumber();
      source = "two_way_devig";
      dq = "real";
    } else {
      // Last-resort fallback: estimate vig as 4.5% total (typical -110/-110)
      // and divide implied prob by (1 + half_vig). Better than the previous
      // 0.975 multiply but still inferred — flag accordingly.
      const halfVig = 0.0225;
      fairProb = bookProb / (1 + halfVig);
      source = "haircut_fallback";
      dq = "inferred";
      anyInferred = true;
    }

    fairProbs.push(fairProb);
    legFairOdds.push({
      side: `${leg.game} — ${leg.side}`,
      book_implied_pct: Number((bookProb * 100).toFixed(3)),
      fair_prob_pct: Number((fairProb * 100).toFixed(3)),
      fair_source: source,
      data_quality: dq,
    });
  }

  if (anyInferred) {
    notes.push(
      "One or more legs lack opposing-side odds; their fair probability is inferred (haircut). Pass `opposing_odds` per leg or pre-compute `fair_prob` for accurate EV."
    );
  }

  // Independent joint = product of fair probabilities.
  const independentJoint = fairProbs.reduce((p, x) => p * x, 1);

  // Compute pairwise correlations and the covariance correction.
  const correlations = computeCorrelations(legs, sport);
  const warnings: string[] = [];
  let covSum = 0;
  for (let i = 0; i < legs.length; i++) {
    for (let j = i + 1; j < legs.length; j++) {
      const idx = pairIndex(i, j, legs.length);
      const ρ = correlations[idx]?.correlation ?? 0;
      const pi = fairProbs[i];
      const pj = fairProbs[j];
      const sigmaI = Math.sqrt(pi * (1 - pi));
      const sigmaJ = Math.sqrt(pj * (1 - pj));
      covSum += ρ * sigmaI * sigmaJ;
    }
  }

  // Joint adjusted by covariance term (first-order). Clamp to valid range.
  let trueJoint = independentJoint + covSum;
  const minMarginal = Math.min(...fairProbs);
  trueJoint = Math.max(0, Math.min(trueJoint, minMarginal));

  // Surface correlation warnings.
  for (const corr of correlations) {
    if (corr.correlation > 0.3) {
      warnings.push(
        `Positive correlation (+${corr.correlation.toFixed(2)}) between "${corr.leg_a}" and "${corr.leg_b}" — boosts joint probability ≈${(corr.correlation * 100).toFixed(0)}%; sportsbooks usually adjust SGP odds for this.`
      );
    } else if (corr.correlation < -0.2) {
      warnings.push(
        `Negative correlation (${corr.correlation.toFixed(2)}) between "${corr.leg_a}" and "${corr.leg_b}" — these legs work against each other; do NOT parlay.`
      );
    }
    if (corr.sample_size < 50 && corr.data_quality !== "real") {
      corr.warning = `Correlation is a prior, not measured (sample_size=${corr.sample_size}). Treat with caution.`;
    }
  }

  const bookImpliedProb = new Decimal(1).div(combinedDecimal).toNumber();
  const juicePct = trueJoint > 0
    ? ((bookImpliedProb - trueJoint) / trueJoint) * 100
    : 0;

  const independentEv =
    (independentJoint * combinedDecimal.toNumber() - 1) * 100;
  const correlationAdjustedEv =
    (trueJoint * combinedDecimal.toNumber() - 1) * 100;

  const hasHardNeg = correlations.some((c) => c.correlation < -0.3);
  const recommended = correlationAdjustedEv > 0 && !hasHardNeg && !anyInferred;

  let reasoning = "";
  if (correlationAdjustedEv > 5)
    reasoning = "Strong +EV parlay after de-vig and correlation adjustment.";
  else if (correlationAdjustedEv > 0)
    reasoning = "Marginal +EV. Bet small if at all — parlay variance is high.";
  else if (correlationAdjustedEv > -5)
    reasoning = "Slightly negative EV — typical parlay juice. Skip.";
  else
    reasoning = "Significantly negative EV. Do not bet.";
  if (hasHardNeg) reasoning += " Negatively correlated legs further reduce true joint probability.";
  if (anyInferred) reasoning += " Note: per-leg fair probabilities are inferred — recompute with opposing odds for confidence.";

  // American odds from combined decimal.
  let combinedAmerican: number;
  if (combinedDecimal.gte(2)) {
    combinedAmerican = combinedDecimal.minus(1).times(100).toDecimalPlaces(0).toNumber();
  } else {
    combinedAmerican = new Decimal(-100).div(combinedDecimal.minus(1)).toDecimalPlaces(0).toNumber();
  }

  // SGP juice analysis (only meaningful when ALL legs are from the same game).
  let sgp_analysis: SgpAnalysis | undefined;
  if (params.book_sgp_american_odds != null) {
    const sameGame = legs.every(
      (l) => normalizeGameName(l.game) === normalizeGameName(legs[0].game)
    );
    if (!sameGame) {
      notes.push(
        "book_sgp_american_odds was supplied but legs are from different games — SGP analysis skipped."
      );
    } else {
      const bookSgpDecimal = americanToDecimal(params.book_sgp_american_odds);
      const bookSgpDec = bookSgpDecimal.toNumber();
      const bookSgpProbImplied = 1 / bookSgpDec;
      const fairDec = trueJoint > 0 ? 1 / trueJoint : Infinity;
      const sgpJuice = trueJoint > 0
        ? ((bookSgpProbImplied / trueJoint) - 1) * 100
        : 0;
      const straightCombinedDec = combinedDecimal.toNumber();
      const sgpVsStraight = ((bookSgpDec / straightCombinedDec) - 1) * 100;

      let rec: SgpAnalysis["recommendation"];
      let rationale: string;
      const sgpEv = (trueJoint * bookSgpDec - 1) * 100;
      if (sgpEv > 1 && sgpVsStraight > -3) {
        rec = "take_sgp";
        rationale = `SGP true EV ${sgpEv.toFixed(2)}% with only ${Math.max(0, -sgpVsStraight).toFixed(1)}% give-up vs straight — book is mispricing the correlation.`;
      } else if (sgpVsStraight > 0 && correlationAdjustedEv > 0) {
        rec = "take_sgp";
        rationale = `Book SGP price beats straight-leg product by ${sgpVsStraight.toFixed(2)}% — correlated EV captured at no premium.`;
      } else if (correlationAdjustedEv > 0) {
        rec = "take_straight";
        rationale = `Legs are individually +EV; book SGP charges ${sgpJuice.toFixed(2)}% extra juice for the correlation. Bet straight.`;
      } else {
        rec = "skip";
        rationale = `Neither SGP (${sgpEv.toFixed(2)}% EV) nor straight (${correlationAdjustedEv.toFixed(2)}% EV) is positive after de-vig.`;
      }

      sgp_analysis = {
        book_sgp_decimal_odds: Number(bookSgpDec.toFixed(4)),
        book_sgp_american_odds: params.book_sgp_american_odds,
        straight_combined_decimal_odds: Number(straightCombinedDec.toFixed(4)),
        fair_decimal_odds: Number.isFinite(fairDec) ? Number(fairDec.toFixed(4)) : 0,
        sgp_juice_pct: Number(sgpJuice.toFixed(2)),
        sgp_vs_straight_pct: Number(sgpVsStraight.toFixed(2)),
        recommendation: rec,
        reasoning: rationale,
      };
    }
  }

  return {
    legs,
    leg_fair_odds: legFairOdds,
    combined_decimal_odds: combinedDecimal.toDecimalPlaces(4).toNumber(),
    combined_american_odds: combinedAmerican,
    independent_true_probability_pct: Number((independentJoint * 100).toFixed(4)),
    true_combined_probability_pct: Number((trueJoint * 100).toFixed(4)),
    book_implied_probability_pct: Number((bookImpliedProb * 100).toFixed(4)),
    juice_percentage: Number(juicePct.toFixed(2)),
    independent_ev_percentage: Number(independentEv.toFixed(2)),
    ev_percentage: Number(correlationAdjustedEv.toFixed(2)),
    correlations,
    correlation_warnings: warnings,
    recommended,
    reasoning,
    data_quality: anyInferred ? "inferred" : "real",
    notes,
    sgp_analysis,
  };
}

// ── Correlation lookup ───────────────────────────────────────────────────────

function pairIndex(i: number, j: number, n: number): number {
  // Index of pair (i,j) in upper triangle ordering used by computeCorrelations.
  // For i<j, index = (i*(2*n - i - 1))/2 + (j - i - 1)
  return (i * (2 * n - i - 1)) / 2 + (j - i - 1);
}

function computeCorrelations(
  legs: ParlayLeg[],
  sport?: string
): CorrelationResult[] {
  const results: CorrelationResult[] = [];
  for (let i = 0; i < legs.length; i++) {
    for (let j = i + 1; j < legs.length; j++) {
      const a = legs[i];
      const b = legs[j];
      const corr = estimateCorrelation(a, b, sport);
      results.push({
        leg_a: `${a.game} — ${a.side}`,
        leg_b: `${b.game} — ${b.side}`,
        correlation: corr.value,
        sample_size: corr.sampleSize,
        data_quality: corr.data_quality,
        note: corr.note,
      });
    }
  }
  return results;
}

function estimateCorrelation(
  a: ParlayLeg,
  b: ParlayLeg,
  sport?: string
): { value: number; sampleSize: number; note: string; data_quality: DataQuality } {
  const aType = a.type.toLowerCase();
  const bType = b.type.toLowerCase();
  const aSide = a.side.toLowerCase();
  const bSide = b.side.toLowerCase();

  // Different games are treated as uncorrelated unless the user passes
  // a known sport-day correlation (e.g., weather across outdoor games).
  if (normalizeGameName(a.game) !== normalizeGameName(b.game)) {
    return {
      value: 0.0,
      sampleSize: 0,
      note: "Different games — assumed uncorrelated.",
      data_quality: "prior",
    };
  }

  // Same game from this point. Need a sport for the prior table.
  if (!sport) {
    return {
      value: 0.1,
      sampleSize: 0,
      note: "Same game, sport not provided — using neutral prior. Pass `sport` for accurate priors.",
      data_quality: "missing",
    };
  }
  const sportCorrs = SPORT_CORRELATIONS[sport.toLowerCase()];
  if (!sportCorrs) {
    return {
      value: 0.1,
      sampleSize: 0,
      note: `Same game, sport "${sport}" has no correlation priors — using neutral.`,
      data_quality: "missing",
    };
  }

  // ML × Total
  if (
    (aType === "h2h" && bType === "total") ||
    (aType === "total" && bType === "h2h")
  ) {
    const totalLeg = aType === "total" ? a : b;
    const mlLeg = aType === "h2h" ? a : b;
    const isOver = totalLeg.side.toLowerCase().includes("over");
    const isFavorite = mlLeg.odds < 0;
    const key = `${isFavorite ? "fav" : "dog"}_ml+${isOver ? "over" : "under"}`;
    const e = sportCorrs[key];
    if (e) return { value: e.value, sampleSize: e.sampleSize, note: e.note, data_quality: e.data_quality };
  }

  // Spread × Total
  if (
    (aType === "spread" && bType === "total") ||
    (aType === "total" && bType === "spread")
  ) {
    const totalLeg = aType === "total" ? a : b;
    const spreadLeg = aType === "spread" ? a : b;
    const isOver = totalLeg.side.toLowerCase().includes("over");
    const isFavorite = (spreadLeg.point ?? 0) < 0;
    const key = `${isFavorite ? "fav" : "dog"}_spread+${isOver ? "over" : "under"}`;
    const e = sportCorrs[key];
    if (e) return { value: e.value, sampleSize: e.sampleSize, note: e.note, data_quality: e.data_quality };
  }

  // Prop × ML/Spread
  if (
    (aType === "prop" && (bType === "h2h" || bType === "spread")) ||
    (bType === "prop" && (aType === "h2h" || aType === "spread"))
  ) {
    const propLeg = aType === "prop" ? a : b;
    const isOverProp = propLeg.side.toLowerCase().includes("over");
    const key = isOverProp ? "prop_over+team_win" : "prop_under+team_win";
    const e = sportCorrs[key];
    if (e) return { value: e.value, sampleSize: e.sampleSize, note: e.note, data_quality: e.data_quality };
  }

  // Prop × Total
  if (
    (aType === "prop" && bType === "total") ||
    (bType === "prop" && aType === "total")
  ) {
    const totalLeg = aType === "total" ? a : b;
    const propLeg = aType === "prop" ? a : b;
    const isOver = totalLeg.side.toLowerCase().includes("over");
    const isOverProp = propLeg.side.toLowerCase().includes("over");
    if (isOver && isOverProp) {
      const e = sportCorrs["prop_over+over"];
      if (e) return { value: e.value, sampleSize: e.sampleSize, note: e.note, data_quality: e.data_quality };
    }
  }

  // Two props same game
  if (aType === "prop" && bType === "prop") {
    const e = sportCorrs["two_props_same_game"];
    if (e) return { value: e.value, sampleSize: e.sampleSize, note: e.note, data_quality: e.data_quality };
  }

  return {
    value: 0.1,
    sampleSize: 0,
    note: "Same game, no specific prior matched — using neutral.",
    data_quality: "missing",
  };
}

function normalizeGameName(name: string): string {
  return name.toLowerCase().replace(/\s*[@vs.]+\s*/g, "|").trim();
}
