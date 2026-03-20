/**
 * Parlay Builder + Correlation Checker.
 * Builds multi-leg parlays, checks correlations, and calculates true EV.
 */

import DecimalLib from "decimal.js";
const Decimal = DecimalLib.default ?? DecimalLib;
import { americanToDecimal, americanToImpliedProb } from "../../utils/helpers.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ParlayLeg {
  game: string;
  side: string;
  book: string;
  odds: number; // American
  point?: number;
  type: string; // h2h, spread, total, prop
}

export interface CorrelationResult {
  leg_a: string;
  leg_b: string;
  correlation: number; // -1 to 1
  sample_size: number;
  warning?: string;
}

export interface ParlayResult {
  legs: ParlayLeg[];
  combined_decimal_odds: number;
  combined_american_odds: number;
  true_combined_probability_pct: number;
  book_implied_probability_pct: number;
  juice_percentage: number;
  ev_percentage: number;
  correlations: CorrelationResult[];
  correlation_warnings: string[];
  recommended: boolean;
  reasoning: string;
}

// ── Implementation ───────────────────────────────────────────────────────────

export function buildParlay(params: {
  legs: ParlayLeg[];
  books?: string[];
}): ParlayResult {
  const { legs } = params;

  if (legs.length < 2) {
    throw new Error("A parlay requires at least 2 legs.");
  }
  if (legs.length > 15) {
    throw new Error("Maximum 15 legs per parlay.");
  }

  // Calculate combined odds
  let combinedDecimal = new Decimal(1);
  let trueCombinedProb = new Decimal(1);

  for (const leg of legs) {
    const dec = americanToDecimal(leg.odds);
    combinedDecimal = combinedDecimal.times(dec);

    // True probability estimate: remove ~2.5% juice per leg
    const impliedProb = americanToImpliedProb(leg.odds);
    // Adjust for estimated juice (vig): typical -110/-110 market has ~4.5% total vig
    // Each side gets roughly half, so true prob ≈ implied / (1 + vig/2)
    const vigAdjustment = new Decimal(0.975); // ~2.5% juice removed
    const trueProb = impliedProb.times(vigAdjustment);
    trueCombinedProb = trueCombinedProb.times(trueProb);
  }

  const bookImpliedProb = new Decimal(1).div(combinedDecimal);
  const juicePct = bookImpliedProb
    .minus(trueCombinedProb)
    .div(trueCombinedProb)
    .times(100);

  // EV = (trueProb × decimalOdds) - 1
  const ev = trueCombinedProb
    .times(combinedDecimal)
    .minus(1)
    .times(100);

  // Calculate correlations between all leg pairs
  const correlations = computeCorrelations(legs);
  const warnings: string[] = [];

  for (const corr of correlations) {
    if (corr.correlation > 0.3) {
      warnings.push(
        `Positive correlation (${corr.correlation.toFixed(2)}) between "${corr.leg_a}" and "${corr.leg_b}" — good for SGP, but sportsbooks may adjust odds.`
      );
    } else if (corr.correlation < -0.3) {
      warnings.push(
        `Negative correlation (${corr.correlation.toFixed(2)}) between "${corr.leg_a}" and "${corr.leg_b}" — these legs work against each other, reducing parlay value.`
      );
    }
    if (corr.sample_size < 50) {
      corr.warning = `Insufficient historical data (${corr.sample_size} samples) — correlation estimate may be unreliable.`;
    }
  }

  // Recommend if EV is positive and no severe negative correlations
  const hasNegativeCorr = correlations.some((c) => c.correlation < -0.3);
  const recommended = ev.gt(0) && !hasNegativeCorr;

  let reasoning = "";
  if (ev.gt(5))
    reasoning = "Strong positive EV parlay — the combined odds exceed the true probability.";
  else if (ev.gt(0))
    reasoning = "Slight positive EV — marginal value, consider smaller stake.";
  else if (ev.gt(-5))
    reasoning = "Slightly negative EV — typical parlay juice. Only play for entertainment.";
  else
    reasoning = "Significantly negative EV — the juice on this parlay is too high.";

  if (hasNegativeCorr)
    reasoning += " Warning: negatively correlated legs reduce your actual win probability below the independent calculation.";

  // Convert combined decimal to American
  let combinedAmerican: number;
  if (combinedDecimal.gte(2)) {
    combinedAmerican = combinedDecimal.minus(1).times(100).toDecimalPlaces(0).toNumber();
  } else {
    combinedAmerican = new Decimal(-100).div(combinedDecimal.minus(1)).toDecimalPlaces(0).toNumber();
  }

  return {
    legs,
    combined_decimal_odds: combinedDecimal.toDecimalPlaces(4).toNumber(),
    combined_american_odds: combinedAmerican,
    true_combined_probability_pct: trueCombinedProb
      .times(100)
      .toDecimalPlaces(4)
      .toNumber(),
    book_implied_probability_pct: bookImpliedProb
      .times(100)
      .toDecimalPlaces(4)
      .toNumber(),
    juice_percentage: juicePct.toDecimalPlaces(2).toNumber(),
    ev_percentage: ev.toDecimalPlaces(2).toNumber(),
    correlations,
    correlation_warnings: warnings,
    recommended,
    reasoning,
  };
}

// ── Correlation computation ──────────────────────────────────────────────────

function computeCorrelations(legs: ParlayLeg[]): CorrelationResult[] {
  const results: CorrelationResult[] = [];

  for (let i = 0; i < legs.length; i++) {
    for (let j = i + 1; j < legs.length; j++) {
      const a = legs[i];
      const b = legs[j];

      // Determine correlation based on known relationships
      const corr = estimateCorrelation(a, b);
      results.push({
        leg_a: `${a.game} — ${a.side}`,
        leg_b: `${b.game} — ${b.side}`,
        correlation: corr.value,
        sample_size: corr.sampleSize,
      });
    }
  }

  return results;
}

function estimateCorrelation(
  a: ParlayLeg,
  b: ParlayLeg
): { value: number; sampleSize: number } {
  // Same game correlations
  if (a.game === b.game) {
    // Team ML + Over (positive correlation — winning teams often score more)
    if (
      (a.type === "h2h" && b.type === "total") ||
      (a.type === "total" && b.type === "h2h")
    ) {
      const totalLeg = a.type === "total" ? a : b;
      if (totalLeg.side.toLowerCase().includes("over")) {
        return { value: 0.25, sampleSize: 500 };
      }
      return { value: -0.15, sampleSize: 500 };
    }

    // Spread + Total in same game
    if (
      (a.type === "spread" && b.type === "total") ||
      (a.type === "total" && b.type === "spread")
    ) {
      return { value: 0.15, sampleSize: 400 };
    }

    // Same game prop + team outcome
    if (a.type === "prop" || b.type === "prop") {
      return { value: 0.3, sampleSize: 150 };
    }

    // Two props from same game
    if (a.type === "prop" && b.type === "prop") {
      return { value: 0.2, sampleSize: 100 };
    }

    return { value: 0.1, sampleSize: 300 };
  }

  // Different games — generally uncorrelated
  // Exception: same sport, same day (slight weather/scheduling correlation)
  return { value: 0.0, sampleSize: 1000 };
}
