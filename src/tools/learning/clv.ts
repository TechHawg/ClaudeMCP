/**
 * Closing Line Value (CLV) Tracker.
 * CLV = the primary performance metric for sharp bettors.
 * Measures whether the line moved in your favor after you bet.
 */

import DecimalLib from "decimal.js";
const Decimal = DecimalLib.default ?? DecimalLib;
import { isDatabaseConfigured, query } from "../../db/client.js";
import { americanToImpliedProb } from "../../utils/helpers.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface CLVInput {
  bet_id: number;
  closing_line: number; // American odds at close
}

export interface CLVResult {
  bet_id: number;
  opening_line: number;
  closing_line: number;
  clv_pct: number;
  clv_direction: "positive" | "negative" | "neutral";
  interpretation: string;
}

export interface ResultInput {
  bet_id: number;
  outcome: "win" | "loss" | "push" | "void";
  actual_payout: number;
}

export interface ResultRecord {
  bet_id: number;
  outcome: string;
  payout: number;
  message: string;
}

// ── Implementation ───────────────────────────────────────────────────────────

export async function recordCLV(input: CLVInput): Promise<CLVResult> {
  if (!isDatabaseConfigured()) {
    throw new Error("DATABASE_URL not configured — CLV tracking requires Postgres.");
  }

  // Fetch original bet
  const bet = await query<{ odds: number; side: string }>(
    "SELECT odds, side FROM bets WHERE id = $1",
    [input.bet_id]
  );

  if (!bet[0]) {
    throw new Error(`Bet #${input.bet_id} not found.`);
  }

  const openingLine = bet[0].odds;
  const closingLine = input.closing_line;

  // Calculate CLV: difference in implied probability
  const openProb = americanToImpliedProb(openingLine);
  const closeProb = americanToImpliedProb(closingLine);

  // CLV = openProb - closeProb (positive means you got a better line than closing)
  // Wait — actually: if you bet +150 and it closes at +130, the closing price is worse
  // for new bettors, meaning you got value. Your implied prob was lower (better).
  const clv = closeProb.minus(openProb).times(100);
  const clvPct = clv.toDecimalPlaces(3).toNumber();

  // Update the bet record
  await query(
    "UPDATE bets SET closing_line = $1, clv = $2 WHERE id = $3",
    [closingLine, clvPct, input.bet_id]
  );

  let direction: CLVResult["clv_direction"];
  let interpretation: string;

  if (clvPct > 0.5) {
    direction = "positive";
    interpretation = `Positive CLV of ${clvPct.toFixed(2)}% — the line moved in your favor after you bet. This indicates a sharp, well-timed wager.`;
  } else if (clvPct < -0.5) {
    direction = "negative";
    interpretation = `Negative CLV of ${clvPct.toFixed(2)}% — the line moved against you. This bet may have been placed at a suboptimal time.`;
  } else {
    direction = "neutral";
    interpretation = `Neutral CLV (${clvPct.toFixed(2)}%) — the line barely moved. No significant timing edge detected.`;
  }

  return {
    bet_id: input.bet_id,
    opening_line: openingLine,
    closing_line: closingLine,
    clv_pct: clvPct,
    clv_direction: direction,
    interpretation,
  };
}

export async function recordResult(input: ResultInput): Promise<ResultRecord> {
  if (!isDatabaseConfigured()) {
    throw new Error("DATABASE_URL not configured — result recording requires Postgres.");
  }

  await query(
    "UPDATE bets SET outcome = $1, payout = $2 WHERE id = $3",
    [input.outcome, input.actual_payout, input.bet_id]
  );

  return {
    bet_id: input.bet_id,
    outcome: input.outcome,
    payout: input.actual_payout,
    message: `Bet #${input.bet_id} result recorded: ${input.outcome}, payout $${input.actual_payout}`,
  };
}
