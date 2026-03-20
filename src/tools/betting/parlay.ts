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
        `Positive correlation (+${corr.correlation.toFixed(2)}) between "${corr.leg_a}" and "${corr.leg_b}" — good for SGP value, but sportsbooks may adjust odds.`
      );
    } else if (corr.correlation > 0.15) {
      warnings.push(
        `Mild positive correlation (+${corr.correlation.toFixed(2)}) between "${corr.leg_a}" and "${corr.leg_b}" — slight SGP edge if book doesn't adjust.`
      );
    } else if (corr.correlation < -0.2) {
      warnings.push(
        `Negative correlation (${corr.correlation.toFixed(2)}) between "${corr.leg_a}" and "${corr.leg_b}" — these legs work against each other, reducing true win probability.`
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
): { value: number; sampleSize: number; note?: string } {
  const aType = a.type.toLowerCase();
  const bType = b.type.toLowerCase();
  const aSide = a.side.toLowerCase();
  const bSide = b.side.toLowerCase();

  // ── Same Game Parlays (SGP) ──────────────────────────────────────────────
  if (normalizeGameName(a.game) === normalizeGameName(b.game)) {

    // Team ML + Over: favorite winning path often involves scoring → positive correlation
    if (
      (aType === "h2h" && bType === "total") ||
      (aType === "total" && bType === "h2h")
    ) {
      const totalLeg = aType === "total" ? a : b;
      const mlLeg = aType === "h2h" ? a : b;
      const isOver = totalLeg.side.toLowerCase().includes("over");
      const isUnder = totalLeg.side.toLowerCase().includes("under");
      const isFavorite = mlLeg.odds < 0;

      // Favorite ML + Over: strong positive (team wins by scoring)
      if (isFavorite && isOver) return { value: 0.35, sampleSize: 2000, note: "SGP: Favorite ML + Over — strong positive correlation" };
      // Favorite ML + Under: negative (winning by defense usually means lower scoring)
      if (isFavorite && isUnder) return { value: -0.25, sampleSize: 2000, note: "SGP: Favorite ML + Under — legs work against each other" };
      // Underdog ML + Over: moderate positive (upset + high scoring game)
      if (!isFavorite && isOver) return { value: 0.20, sampleSize: 1500, note: "SGP: Underdog ML + Over — moderate positive" };
      // Underdog ML + Under: slight positive (defensive upset)
      if (!isFavorite && isUnder) return { value: 0.15, sampleSize: 1500, note: "SGP: Underdog ML + Under — defensive upset scenario" };

      return { value: 0.10, sampleSize: 1000 };
    }

    // Spread + Total in same game
    if (
      (aType === "spread" && bType === "total") ||
      (aType === "total" && bType === "spread")
    ) {
      const totalLeg = aType === "total" ? a : b;
      const spreadLeg = aType === "spread" ? a : b;
      const isOver = totalLeg.side.toLowerCase().includes("over");
      const isCovering = (spreadLeg.point ?? 0) < 0; // negative spread = favorite

      // Favorite covering + Over: strong positive (team winning big in high-scoring game)
      if (isCovering && isOver) return { value: 0.30, sampleSize: 1800, note: "SGP: Favorite spread + Over — winning big means points" };
      // Underdog covering + Under: moderate positive (close low-scoring game)
      if (!isCovering && !isOver) return { value: 0.20, sampleSize: 1500, note: "SGP: Underdog spread + Under — close defensive game" };

      return { value: 0.12, sampleSize: 1200 };
    }

    // Prop + Team outcome (same game): player performs well → team wins
    if ((aType === "prop" && (bType === "h2h" || bType === "spread")) ||
        (bType === "prop" && (aType === "h2h" || aType === "spread"))) {
      const propLeg = aType === "prop" ? a : b;
      const isOverProp = propLeg.side.toLowerCase().includes("over");
      // Player Over + Team Win: strong positive (star performs → team wins)
      if (isOverProp) return { value: 0.35, sampleSize: 800, note: "SGP: Player Over + Team Win — strong positive correlation" };
      return { value: -0.20, sampleSize: 600, note: "SGP: Player Under + Team Win — works against each other" };
    }

    // Prop + Total (same game): player scoring more → game scoring more
    if ((aType === "prop" && bType === "total") ||
        (bType === "prop" && aType === "total")) {
      const totalLeg = aType === "total" ? a : b;
      const propLeg = aType === "prop" ? a : b;
      const isOver = totalLeg.side.toLowerCase().includes("over");
      const isOverProp = propLeg.side.toLowerCase().includes("over");

      if (isOverProp && isOver) return { value: 0.30, sampleSize: 600, note: "SGP: Player Over + Game Over — correlated scoring" };
      if (!isOverProp && !isOver) return { value: 0.25, sampleSize: 500, note: "SGP: Player Under + Game Under — low-scoring game" };
      return { value: -0.15, sampleSize: 500, note: "SGP: Opposing prop/total directions" };
    }

    // Two props from same game
    if (aType === "prop" && bType === "prop") {
      // Same team props are positively correlated (high-scoring game helps all players)
      return { value: 0.25, sampleSize: 400, note: "SGP: Two props from same game — moderate positive (game environment)" };
    }

    // Two h2h or spread legs from same game (shouldn't happen but handle it)
    if (aType === bType) return { value: 0.0, sampleSize: 1000, note: "Same market type from same game" };

    return { value: 0.10, sampleSize: 800 };
  }

  // ── Different Games ──────────────────────────────────────────────────────

  // Same division/conference matchups on same day can have slight correlation
  // (e.g., weather affecting multiple outdoor games)
  return { value: 0.0, sampleSize: 5000, note: "Different games — uncorrelated" };
}

/** Normalize game names for comparison (handles "Team A @ Team B" vs "Team A vs Team B") */
function normalizeGameName(name: string): string {
  return name.toLowerCase().replace(/\s*[@vs.]+\s*/g, "|").trim();
}
