/**
 * Kelly Criterion Bet Sizing — with optional per-market override.
 *
 * If the caller passes `sport` + `bet_type` (and optionally `book`), Kelly
 * fraction is auto-resolved from market_bankroll_allocations. A market with
 * negative CLV will return kelly=0 → recommendedBet=0, refusing the play.
 */

import { kellyBetSize, type KellyResult } from "../../utils/helpers.js";
import { resolveKellyFraction } from "../learning/market_bankroll.js";
import { getRiskStatus } from "../learning/risk_status.js";

export interface KellyInput {
  bankroll: number;
  edge_percentage: number;
  odds: number; // American odds
  kelly_fraction?: number; // explicit override
  /** If true (default), the edge_percentage is treated as a no-vig edge. */
  edge_is_no_vig?: boolean;
  // Optional cluster identification for per-market override:
  sport?: string;
  bet_type?: string;
  book?: string;
}

export interface KellyOutput extends KellyResult {
  bankroll: number;
  edge_percentage: number;
  odds_american: number;
  odds_decimal: number;
  kelly_fraction_used: number;
  fraction_source: string;
  market_allocation_cap_pct?: number;
  // Drawdown circuit breaker
  drawdown_multiplier?: number;
  drawdown_band?: string;
  daily_limit_breached?: boolean;
  warning?: string;
}

export async function calculateKelly(params: KellyInput): Promise<KellyOutput> {
  // Resolve fraction: explicit > per-market override > 0.25 default
  let fraction = params.kelly_fraction;
  let fractionSource = "explicit";
  let allocationCapPct: number | undefined;

  if (fraction == null && params.sport && params.bet_type) {
    const resolved = await resolveKellyFraction({
      sport: params.sport,
      bet_type: params.bet_type,
      book: params.book,
    });
    fraction = resolved.kelly_fraction;
    fractionSource = resolved.sourced_from_db ? `market_override:${resolved.basis}` : "default";
    allocationCapPct = resolved.allocation_pct;
  }
  if (fraction == null) {
    fraction = 0.25;
    fractionSource = "default";
  }

  // Penalize fraction by 40% if edge is not flagged no-vig — historical implementations
  // have used juiced Pinnacle prob as if it were true, which inflated edge estimates.
  if (params.edge_is_no_vig === false || params.edge_is_no_vig === undefined) {
    fraction = fraction * 0.6;
    fractionSource = `${fractionSource}+haircut_for_juiced_edge`;
  }

  // Convert American odds to decimal
  let decimalOdds: number;
  if (params.odds > 0) {
    decimalOdds = params.odds / 100 + 1;
  } else {
    decimalOdds = 100 / Math.abs(params.odds) + 1;
  }

  // Drawdown circuit breaker — multiplies fraction by [0..1] depending on
  // current drawdown vs peak. Returns 0 if daily loss limit is breached.
  const risk = await getRiskStatus();
  if (risk.kelly_multiplier < 1) {
    fraction = fraction * risk.kelly_multiplier;
    fractionSource = `${fractionSource}+drawdown_${risk.drawdown_band}(×${risk.kelly_multiplier})`;
  }

  let result = kellyBetSize(params.bankroll, params.edge_percentage, decimalOdds, fraction);

  // Apply market allocation cap: never bet more than allocation_pct of bankroll on this cluster.
  if (allocationCapPct != null) {
    const capDollars = (allocationCapPct / 100) * params.bankroll;
    if (result.recommendedBet > capDollars) {
      result = {
        ...result,
        recommendedBet: Number(capDollars.toFixed(2)),
        kellyPercentage: allocationCapPct,
      };
    }
  }

  let warning: string | undefined;
  if (risk.daily_limit_breached) {
    warning = "DAILY LOSS LIMIT BREACHED — no new bets until tomorrow.";
  } else if (fraction === 0) {
    warning = "Sizing zeroed by per-market allocation or drawdown breaker. DO NOT BET.";
  } else if (result.kellyPercentage <= 0) {
    warning = "Kelly formula suggests no bet — the edge is insufficient at these odds.";
  } else if (risk.drawdown_band === "halve" || risk.drawdown_band === "quarter") {
    warning = `Drawdown breaker active (${risk.drawdown_band}) — sizing reduced. Reconsider whether to bet at all.`;
  } else if (result.riskAssessment === "extreme") {
    warning = "Extreme risk — consider reducing kelly_fraction to 0.1 (tenth Kelly) or lowering stake.";
  } else if (result.riskAssessment === "high") {
    warning = "High risk — ensure your edge estimate is accurate. Default to quarter Kelly (0.25).";
  }

  return {
    ...result,
    bankroll: params.bankroll,
    edge_percentage: params.edge_percentage,
    odds_american: params.odds,
    odds_decimal: decimalOdds,
    kelly_fraction_used: Number(fraction.toFixed(3)),
    fraction_source: fractionSource,
    market_allocation_cap_pct: allocationCapPct,
    drawdown_multiplier: risk.kelly_multiplier,
    drawdown_band: risk.drawdown_band,
    daily_limit_breached: risk.daily_limit_breached,
    warning,
  };
}
