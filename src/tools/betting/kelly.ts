/**
 * Kelly Criterion Bet Sizing.
 * Precise decimal arithmetic for all monetary calculations.
 */

import { kellyBetSize, type KellyResult } from "../../utils/helpers.js";

export interface KellyInput {
  bankroll: number;
  edge_percentage: number;
  odds: number; // American odds
  kelly_fraction?: number; // default 0.25 (quarter Kelly)
}

export interface KellyOutput extends KellyResult {
  bankroll: number;
  edge_percentage: number;
  odds_american: number;
  odds_decimal: number;
  kelly_fraction_used: number;
  warning?: string;
}

export function calculateKelly(params: KellyInput): KellyOutput {
  const fraction = params.kelly_fraction ?? 0.25;

  // Convert American odds to decimal
  let decimalOdds: number;
  if (params.odds > 0) {
    decimalOdds = params.odds / 100 + 1;
  } else {
    decimalOdds = 100 / Math.abs(params.odds) + 1;
  }

  const result = kellyBetSize(
    params.bankroll,
    params.edge_percentage,
    decimalOdds,
    fraction
  );

  let warning: string | undefined;
  if (result.kellyPercentage <= 0) {
    warning =
      "Kelly formula suggests no bet — the edge is insufficient at these odds.";
  } else if (result.riskAssessment === "extreme") {
    warning =
      "Extreme risk — consider reducing kelly_fraction to 0.1 (tenth Kelly) or lowering stake.";
  } else if (result.riskAssessment === "high") {
    warning =
      "High risk bet — ensure your edge estimate is accurate. Consider quarter Kelly (0.25) if not already using it.";
  }

  return {
    ...result,
    bankroll: params.bankroll,
    edge_percentage: params.edge_percentage,
    odds_american: params.odds,
    odds_decimal: decimalOdds,
    kelly_fraction_used: fraction,
    warning,
  };
}
