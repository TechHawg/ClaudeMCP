/**
 * Risk-status / drawdown circuit breaker.
 *
 * Reads bankroll_ledger to compute current drawdown vs peak. Returns a
 * `kelly_multiplier` in [0, 1] that the Kelly tool applies on top of the
 * per-market fraction. Daily loss limit is also enforced.
 *
 * Bands:
 *   - drawdown ≥ 25% → multiplier 0.25 (quarter sizing)
 *   - drawdown ≥ 15% → multiplier 0.50 (half sizing)
 *   - drawdown ≥  8% → multiplier 0.75 (cautious)
 *   - else            → multiplier 1.00
 *
 * Daily loss limit:
 *   - If today's net P/L < -DAILY_LOSS_LIMIT_PCT × peak, multiplier drops to 0
 *     (refuse new bets for the rest of the day).
 *   - Default DAILY_LOSS_LIMIT_PCT = 5% of peak bankroll.
 */

import { isDatabaseConfigured, query } from "../../db/client.js";

export interface RiskStatus {
  current_balance: number;
  peak_balance: number;
  starting_balance: number;
  current_drawdown_pct: number;
  drawdown_band: "ok" | "cautious" | "halve" | "quarter";
  kelly_multiplier: number;
  daily_loss_limit_pct: number;
  today_pl_pct_of_peak: number;
  daily_limit_breached: boolean;
  recommended_action: string;
  notes: string[];
}

const DEFAULTS = {
  // Kelly multiplier bands
  CAUTIOUS_THRESHOLD_PCT: 8,
  HALVE_THRESHOLD_PCT: 15,
  QUARTER_THRESHOLD_PCT: 25,
  // Daily loss limit (% of peak)
  DAILY_LOSS_LIMIT_PCT: 5,
};

export async function getRiskStatus(params: {
  /** Override the default daily loss limit (% of peak). */
  daily_loss_limit_pct?: number;
} = {}): Promise<RiskStatus> {
  const dailyLimit = params.daily_loss_limit_pct ?? DEFAULTS.DAILY_LOSS_LIMIT_PCT;
  const notes: string[] = [];

  if (!isDatabaseConfigured()) {
    return {
      current_balance: 0,
      peak_balance: 0,
      starting_balance: 0,
      current_drawdown_pct: 0,
      drawdown_band: "ok",
      kelly_multiplier: 1,
      daily_loss_limit_pct: dailyLimit,
      today_pl_pct_of_peak: 0,
      daily_limit_breached: false,
      recommended_action: "Default sizing — no DB; risk gates inactive.",
      notes: ["DATABASE_URL not set — drawdown breaker requires Postgres."],
    };
  }

  // Pull bankroll history. The ledger is append-only with a `balance` column
  // representing balance after the action.
  const rows = await query<{
    created_at: string;
    balance: string | number;
    action: string;
    amount: string | number;
  }>(
    `SELECT created_at, balance, action, amount
       FROM bankroll_ledger
       ORDER BY created_at ASC`
  );

  if (rows.length === 0) {
    notes.push("No bankroll history. Run `bankroll set_balance <amount>` first.");
    return {
      current_balance: 0,
      peak_balance: 0,
      starting_balance: 0,
      current_drawdown_pct: 0,
      drawdown_band: "ok",
      kelly_multiplier: 1,
      daily_loss_limit_pct: dailyLimit,
      today_pl_pct_of_peak: 0,
      daily_limit_breached: false,
      recommended_action: "Set bankroll first.",
      notes,
    };
  }

  const balances = rows.map((r) => Number(r.balance));
  const startingBalance = balances[0];
  const currentBalance = balances[balances.length - 1];
  const peakBalance = Math.max(...balances);
  const drawdownPct = peakBalance > 0
    ? ((peakBalance - currentBalance) / peakBalance) * 100
    : 0;

  // Today's P/L computed from the change in balance from start-of-day to now.
  const todayKey = new Date().toISOString().slice(0, 10);
  const todayRows = rows.filter((r) => r.created_at.startsWith(todayKey));
  let todayPlPct = 0;
  if (todayRows.length > 0) {
    // Find the last balance from before today.
    const lastBeforeToday = rows
      .filter((r) => !r.created_at.startsWith(todayKey))
      .pop();
    const startOfDay = lastBeforeToday ? Number(lastBeforeToday.balance) : startingBalance;
    const todayPl = currentBalance - startOfDay;
    todayPlPct = peakBalance > 0 ? (todayPl / peakBalance) * 100 : 0;
  }

  // Determine band
  let band: RiskStatus["drawdown_band"] = "ok";
  let multiplier = 1;
  if (drawdownPct >= DEFAULTS.QUARTER_THRESHOLD_PCT) {
    band = "quarter";
    multiplier = 0.25;
  } else if (drawdownPct >= DEFAULTS.HALVE_THRESHOLD_PCT) {
    band = "halve";
    multiplier = 0.5;
  } else if (drawdownPct >= DEFAULTS.CAUTIOUS_THRESHOLD_PCT) {
    band = "cautious";
    multiplier = 0.75;
  }

  // Daily loss limit
  const dailyLimitBreached = todayPlPct < -dailyLimit;
  if (dailyLimitBreached) {
    multiplier = 0;
    notes.push(
      `Daily loss limit breached: today's P/L is ${todayPlPct.toFixed(2)}% of peak (limit ${dailyLimit}%). No new bets until tomorrow.`
    );
  }

  let recommendation: string;
  if (dailyLimitBreached) {
    recommendation = "STOP — daily loss limit hit. Resume tomorrow.";
  } else if (band === "quarter") {
    recommendation = `Severe drawdown ${drawdownPct.toFixed(1)}%. Sizing reduced to 25%. Re-evaluate edge sources and consider stopping.`;
  } else if (band === "halve") {
    recommendation = `Drawdown ${drawdownPct.toFixed(1)}%. Sizing halved. Tighten standards (no inferred-quality plays).`;
  } else if (band === "cautious") {
    recommendation = `Drawdown ${drawdownPct.toFixed(1)}%. Cautious sizing applied (×0.75).`;
  } else {
    recommendation = `Drawdown ${drawdownPct.toFixed(1)}%. Default sizing.`;
  }

  return {
    current_balance: Number(currentBalance.toFixed(2)),
    peak_balance: Number(peakBalance.toFixed(2)),
    starting_balance: Number(startingBalance.toFixed(2)),
    current_drawdown_pct: Number(drawdownPct.toFixed(2)),
    drawdown_band: band,
    kelly_multiplier: multiplier,
    daily_loss_limit_pct: dailyLimit,
    today_pl_pct_of_peak: Number(todayPlPct.toFixed(2)),
    daily_limit_breached: dailyLimitBreached,
    recommended_action: recommendation,
    notes,
  };
}
