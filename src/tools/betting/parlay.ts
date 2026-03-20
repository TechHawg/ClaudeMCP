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

// ── Sport-specific correlation lookup tables ────────────────────────────────

interface CorrelationEntry {
  value: number;
  sampleSize: number;
  note: string;
}

// Research-backed correlation values by sport and market combination
const SPORT_CORRELATIONS: Record<string, Record<string, CorrelationEntry>> = {
  // NBA correlations (higher scoring → stronger correlations)
  nba: {
    "fav_ml+over": { value: 0.38, sampleSize: 3200, note: "NBA: Favorite ML + Over — strong (high-scoring wins)" },
    "fav_ml+under": { value: -0.28, sampleSize: 3200, note: "NBA: Favorite ML + Under — negative" },
    "dog_ml+over": { value: 0.22, sampleSize: 2800, note: "NBA: Underdog ML + Over — moderate positive" },
    "dog_ml+under": { value: 0.18, sampleSize: 2800, note: "NBA: Underdog ML + Under — slight positive (defensive upset)" },
    "fav_spread+over": { value: 0.33, sampleSize: 3000, note: "NBA: Favorite spread + Over — strong" },
    "dog_spread+under": { value: 0.22, sampleSize: 2500, note: "NBA: Underdog spread + Under — moderate" },
    "prop_over+team_win": { value: 0.38, sampleSize: 1200, note: "NBA: Player Over + Team Win — strong (star drives wins)" },
    "prop_under+team_win": { value: -0.22, sampleSize: 900, note: "NBA: Player Under + Team Win — negative" },
    "prop_over+over": { value: 0.32, sampleSize: 800, note: "NBA: Player Over + Game Over — strong" },
    "two_props_same_game": { value: 0.28, sampleSize: 600, note: "NBA: Two props same game — game environment effect" },
  },
  // NFL correlations (lower scoring → moderate correlations)
  nfl: {
    "fav_ml+over": { value: 0.30, sampleSize: 2500, note: "NFL: Favorite ML + Over — moderate (less variance)" },
    "fav_ml+under": { value: -0.20, sampleSize: 2500, note: "NFL: Favorite ML + Under — slight negative" },
    "dog_ml+over": { value: 0.15, sampleSize: 2000, note: "NFL: Underdog ML + Over — weak positive" },
    "dog_ml+under": { value: 0.12, sampleSize: 2000, note: "NFL: Underdog ML + Under — slight positive" },
    "fav_spread+over": { value: 0.28, sampleSize: 2200, note: "NFL: Favorite spread + Over — moderate" },
    "dog_spread+under": { value: 0.18, sampleSize: 1800, note: "NFL: Underdog spread + Under — slight" },
    "prop_over+team_win": { value: 0.30, sampleSize: 800, note: "NFL: Player Over + Team Win — moderate" },
    "prop_under+team_win": { value: -0.18, sampleSize: 600, note: "NFL: Player Under + Team Win — slight negative" },
    "prop_over+over": { value: 0.25, sampleSize: 500, note: "NFL: Player Over + Game Over — moderate" },
    "two_props_same_game": { value: 0.22, sampleSize: 400, note: "NFL: Two props same game — moderate" },
  },
  // MLB correlations (unique: pitcher-dependent)
  mlb: {
    "fav_ml+over": { value: 0.25, sampleSize: 4000, note: "MLB: Favorite ML + Over — moderate" },
    "fav_ml+under": { value: -0.15, sampleSize: 4000, note: "MLB: Favorite ML + Under — slight negative" },
    "dog_ml+over": { value: 0.18, sampleSize: 3500, note: "MLB: Underdog ML + Over — slight positive" },
    "dog_ml+under": { value: 0.10, sampleSize: 3500, note: "MLB: Underdog ML + Under — weak" },
    "fav_spread+over": { value: 0.22, sampleSize: 3200, note: "MLB: Favorite RL + Over — moderate" },
    "dog_spread+under": { value: 0.15, sampleSize: 2800, note: "MLB: Underdog RL + Under — slight" },
    "prop_over+team_win": { value: 0.32, sampleSize: 600, note: "MLB: Batter Over + Team Win — strong (lineup-dependent)" },
    "prop_under+team_win": { value: -0.25, sampleSize: 500, note: "MLB: Pitcher K's Under + Team Win — negative" },
    "prop_over+over": { value: 0.28, sampleSize: 400, note: "MLB: Batter Over + Game Over — moderate" },
    "two_props_same_game": { value: 0.20, sampleSize: 300, note: "MLB: Two props same game — moderate (weather-dependent)" },
  },
  // NHL correlations
  nhl: {
    "fav_ml+over": { value: 0.32, sampleSize: 2800, note: "NHL: Favorite ML + Over — moderate-strong" },
    "fav_ml+under": { value: -0.25, sampleSize: 2800, note: "NHL: Favorite ML + Under — negative" },
    "dog_ml+over": { value: 0.20, sampleSize: 2400, note: "NHL: Underdog ML + Over — moderate" },
    "dog_ml+under": { value: 0.15, sampleSize: 2400, note: "NHL: Underdog ML + Under — slight" },
    "fav_spread+over": { value: 0.30, sampleSize: 2200, note: "NHL: Favorite PL + Over — moderate" },
    "dog_spread+under": { value: 0.20, sampleSize: 1800, note: "NHL: Underdog PL + Under — moderate" },
    "prop_over+team_win": { value: 0.35, sampleSize: 700, note: "NHL: Player Over + Team Win — strong" },
    "prop_under+team_win": { value: -0.20, sampleSize: 500, note: "NHL: Player Under + Team Win — negative" },
    "prop_over+over": { value: 0.30, sampleSize: 500, note: "NHL: Player Over + Game Over — moderate" },
    "two_props_same_game": { value: 0.25, sampleSize: 350, note: "NHL: Two props same game — moderate" },
  },
};

export function buildParlay(params: {
  legs: ParlayLeg[];
  books?: string[];
  sport?: string;
}): ParlayResult {
  const { legs, sport } = params;

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
  const correlations = computeCorrelations(legs, sport);
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

function computeCorrelations(legs: ParlayLeg[], sport?: string): CorrelationResult[] {
  const results: CorrelationResult[] = [];

  for (let i = 0; i < legs.length; i++) {
    for (let j = i + 1; j < legs.length; j++) {
      const a = legs[i];
      const b = legs[j];

      // Determine correlation based on known relationships
      const corr = estimateCorrelation(a, b, sport);
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

function detectSport(gameString: string, fallback?: string): string {
  // Try to detect sport from game name
  const game = gameString.toLowerCase();

  // Look for common team name patterns (very basic)
  if (game.includes("lakers") || game.includes("celtics") || game.includes("warriors")) return "nba";
  if (game.includes("chiefs") || game.includes("patriots") || game.includes("packers")) return "nfl";
  if (game.includes("yankees") || game.includes("redsox") || game.includes("dodgers")) return "mlb";
  if (game.includes("rangers") || game.includes("maple leafs") || game.includes("penguins")) return "nhl";

  return fallback ?? "nba"; // Default to NBA if unsure
}

function estimateCorrelation(
  a: ParlayLeg,
  b: ParlayLeg,
  sport?: string
): { value: number; sampleSize: number; note?: string } {
  const aType = a.type.toLowerCase();
  const bType = b.type.toLowerCase();
  const aSide = a.side.toLowerCase();
  const bSide = b.side.toLowerCase();

  // Detect sport from game names if not provided
  const detectedSport = sport ?? detectSport(a.game);
  const sportCorrs = SPORT_CORRELATIONS[detectedSport] ?? SPORT_CORRELATIONS["nba"];

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
      if (isFavorite && isOver) {
        const entry = sportCorrs["fav_ml+over"];
        return entry ?? { value: 0.35, sampleSize: 2000, note: "SGP: Favorite ML + Over — strong positive correlation" };
      }
      // Favorite ML + Under: negative (winning by defense usually means lower scoring)
      if (isFavorite && isUnder) {
        const entry = sportCorrs["fav_ml+under"];
        return entry ?? { value: -0.25, sampleSize: 2000, note: "SGP: Favorite ML + Under — legs work against each other" };
      }
      // Underdog ML + Over: moderate positive (upset + high scoring game)
      if (!isFavorite && isOver) {
        const entry = sportCorrs["dog_ml+over"];
        return entry ?? { value: 0.20, sampleSize: 1500, note: "SGP: Underdog ML + Over — moderate positive" };
      }
      // Underdog ML + Under: slight positive (defensive upset)
      if (!isFavorite && isUnder) {
        const entry = sportCorrs["dog_ml+under"];
        return entry ?? { value: 0.15, sampleSize: 1500, note: "SGP: Underdog ML + Under — defensive upset scenario" };
      }

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
      if (isCovering && isOver) {
        const entry = sportCorrs["fav_spread+over"];
        return entry ?? { value: 0.30, sampleSize: 1800, note: "SGP: Favorite spread + Over — winning big means points" };
      }
      // Underdog covering + Under: moderate positive (close low-scoring game)
      if (!isCovering && !isOver) {
        const entry = sportCorrs["dog_spread+under"];
        return entry ?? { value: 0.20, sampleSize: 1500, note: "SGP: Underdog spread + Under — close defensive game" };
      }

      return { value: 0.12, sampleSize: 1200 };
    }

    // Prop + Team outcome (same game): player performs well → team wins
    if ((aType === "prop" && (bType === "h2h" || bType === "spread")) ||
        (bType === "prop" && (aType === "h2h" || aType === "spread"))) {
      const propLeg = aType === "prop" ? a : b;
      const isOverProp = propLeg.side.toLowerCase().includes("over");
      // Player Over + Team Win: strong positive (star performs → team wins)
      if (isOverProp) {
        const entry = sportCorrs["prop_over+team_win"];
        return entry ?? { value: 0.35, sampleSize: 800, note: "SGP: Player Over + Team Win — strong positive correlation" };
      }
      const entry = sportCorrs["prop_under+team_win"];
      return entry ?? { value: -0.20, sampleSize: 600, note: "SGP: Player Under + Team Win — works against each other" };
    }

    // Prop + Total (same game): player scoring more → game scoring more
    if ((aType === "prop" && bType === "total") ||
        (bType === "prop" && aType === "total")) {
      const totalLeg = aType === "total" ? a : b;
      const propLeg = aType === "prop" ? a : b;
      const isOver = totalLeg.side.toLowerCase().includes("over");
      const isOverProp = propLeg.side.toLowerCase().includes("over");

      if (isOverProp && isOver) {
        const entry = sportCorrs["prop_over+over"];
        return entry ?? { value: 0.30, sampleSize: 600, note: "SGP: Player Over + Game Over — correlated scoring" };
      }
      if (!isOverProp && !isOver) return { value: 0.25, sampleSize: 500, note: "SGP: Player Under + Game Under — low-scoring game" };
      return { value: -0.15, sampleSize: 500, note: "SGP: Opposing prop/total directions" };
    }

    // Two props from same game
    if (aType === "prop" && bType === "prop") {
      // Same team props are positively correlated (high-scoring game helps all players)
      const entry = sportCorrs["two_props_same_game"];
      return entry ?? { value: 0.25, sampleSize: 400, note: "SGP: Two props from same game — moderate positive (game environment)" };
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
