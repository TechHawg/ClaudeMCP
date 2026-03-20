/**
 * Bankroll Tracker
 * Tracks running bankroll, drawdown, units wagered, and Kelly compliance.
 * Stored in Postgres bankroll_ledger table.
 */

import { isDatabaseConfigured, query, queryOne } from "../../db/client.js";
import DecimalLib from "decimal.js";
const Decimal = DecimalLib.default ?? DecimalLib;

// ── Types ────────────────────────────────────────────────────────────────────

interface BankrollStatus {
  current_balance: number;
  starting_balance: number;
  peak_balance: number;
  trough_balance: number;
  current_drawdown_pct: number; // from peak
  total_profit: number;
  total_roi_pct: number;
  total_wagered: number;
  total_bets: number;
  win_rate: number;
  today: DayStats;
  this_week: DayStats;
  this_month: DayStats;
  kelly_compliance: KellyCompliance;
  message: string;
}

interface DayStats {
  bets: number;
  wagered: number;
  profit: number;
  roi_pct: number;
}

interface KellyCompliance {
  avg_stake_pct: number; // average stake as % of bankroll at time of bet
  over_kelly_count: number; // bets where stake > recommended Kelly
  compliance_rating: string;
  message: string;
}

interface BankrollAction {
  action: "deposit" | "withdraw" | "set_balance";
  amount: number;
  note?: string;
}

interface BankrollResult {
  status?: BankrollStatus;
  action_result?: string;
  message: string;
}

// ── Implementation ───────────────────────────────────────────────────────────

export async function manageBankroll(params: {
  action?: string; // "status" | "deposit" | "withdraw" | "set_balance"
  amount?: number;
  note?: string;
}): Promise<BankrollResult> {
  if (!isDatabaseConfigured()) {
    throw new Error(
      "Database not configured. Bankroll tracking requires DATABASE_URL. " +
        "Set it to your PostgreSQL connection string."
    );
  }

  const action = params.action ?? "status";

  if (action === "deposit" || action === "withdraw" || action === "set_balance") {
    return handleBankrollAction(action, params.amount ?? 0, params.note);
  }

  return getBankrollStatus();
}

// ── Get full bankroll status ─────────────────────────────────────────────────

async function getBankrollStatus(): Promise<BankrollResult> {
  // Get latest ledger entry
  const latest = await queryOne<{
    balance: string;
  }>(
    `SELECT balance FROM bankroll_ledger ORDER BY created_at DESC LIMIT 1`
  );

  if (!latest) {
    return {
      message:
        'No bankroll data. Use action "set_balance" with your starting bankroll to begin tracking. ' +
        'Example: { action: "set_balance", amount: 5000, note: "Starting bankroll" }',
    };
  }

  const currentBalance = parseFloat(latest.balance);

  // Get starting balance (first entry)
  const first = await queryOne<{ balance: string }>(
    `SELECT balance FROM bankroll_ledger ORDER BY created_at ASC LIMIT 1`
  );
  const startingBalance = first ? parseFloat(first.balance) : currentBalance;

  // Get peak and trough
  const peak = await queryOne<{ max: string }>(
    `SELECT MAX(balance) as max FROM bankroll_ledger`
  );
  const trough = await queryOne<{ min: string }>(
    `SELECT MIN(balance) as min FROM bankroll_ledger`
  );
  const peakBalance = peak ? parseFloat(peak.max) : currentBalance;
  const troughBalance = trough ? parseFloat(trough.min) : currentBalance;

  const drawdownPct =
    peakBalance > 0
      ? new Decimal(peakBalance)
          .minus(currentBalance)
          .div(peakBalance)
          .times(100)
          .toDecimalPlaces(1)
          .toNumber()
      : 0;

  // Get bet stats from bets table
  const betStats = await queryOne<{
    total_bets: string;
    total_wagered: string;
    total_payout: string;
    wins: string;
  }>(
    `SELECT
       COUNT(*) as total_bets,
       COALESCE(SUM(stake), 0) as total_wagered,
       COALESCE(SUM(CASE WHEN outcome = 'win' THEN payout ELSE 0 END), 0) as total_payout,
       COUNT(CASE WHEN outcome = 'win' THEN 1 END) as wins
     FROM bets
     WHERE outcome IS NOT NULL`
  );

  const totalBets = parseInt(betStats?.total_bets ?? "0");
  const totalWagered = parseFloat(betStats?.total_wagered ?? "0");
  const totalPayout = parseFloat(betStats?.total_payout ?? "0");
  const wins = parseInt(betStats?.wins ?? "0");
  const resolvedBets = totalBets > 0 ? totalBets : 1;

  const totalProfit = currentBalance - startingBalance;
  const totalRoi = totalWagered > 0
    ? new Decimal(totalProfit).div(totalWagered).times(100).toDecimalPlaces(1).toNumber()
    : 0;
  const winRate = new Decimal(wins).div(resolvedBets).times(100).toDecimalPlaces(1).toNumber();

  // Time-based stats
  const today = await getPeriodStats("NOW() - INTERVAL '1 day'");
  const thisWeek = await getPeriodStats("NOW() - INTERVAL '7 days'");
  const thisMonth = await getPeriodStats("NOW() - INTERVAL '30 days'");

  // Kelly compliance
  const kellyCompliance = await getKellyCompliance(currentBalance);

  const status: BankrollStatus = {
    current_balance: currentBalance,
    starting_balance: startingBalance,
    peak_balance: peakBalance,
    trough_balance: troughBalance,
    current_drawdown_pct: drawdownPct,
    total_profit: parseFloat(totalProfit.toFixed(2)),
    total_roi_pct: totalRoi,
    total_wagered: totalWagered,
    total_bets: totalBets,
    win_rate: winRate,
    today,
    this_week: thisWeek,
    this_month: thisMonth,
    kelly_compliance: kellyCompliance,
    message: buildStatusMessage(currentBalance, drawdownPct, totalProfit, totalRoi),
  };

  return { status, message: status.message };
}

// ── Period stats ─────────────────────────────────────────────────────────────

async function getPeriodStats(since: string): Promise<DayStats> {
  const row = await queryOne<{
    bets: string;
    wagered: string;
    profit: string;
  }>(
    `SELECT
       COUNT(*) as bets,
       COALESCE(SUM(stake), 0) as wagered,
       COALESCE(SUM(CASE WHEN outcome = 'win' THEN payout - stake WHEN outcome = 'loss' THEN -stake ELSE 0 END), 0) as profit
     FROM bets
     WHERE created_at >= ${since} AND outcome IS NOT NULL`
  );

  const bets = parseInt(row?.bets ?? "0");
  const wagered = parseFloat(row?.wagered ?? "0");
  const profit = parseFloat(row?.profit ?? "0");
  const roi = wagered > 0
    ? new Decimal(profit).div(wagered).times(100).toDecimalPlaces(1).toNumber()
    : 0;

  return { bets, wagered, profit: parseFloat(profit.toFixed(2)), roi_pct: roi };
}

// ── Kelly compliance ─────────────────────────────────────────────────────────

async function getKellyCompliance(currentBankroll: number): Promise<KellyCompliance> {
  const rows = await query<{
    stake: string;
    kelly_fraction: string;
    edge_pct: string;
    odds: number;
  }>(
    `SELECT stake, kelly_fraction, edge_pct, odds
     FROM bets
     WHERE kelly_fraction IS NOT NULL AND created_at >= NOW() - INTERVAL '30 days'
     ORDER BY created_at DESC
     LIMIT 100`
  );

  if (rows.length === 0) {
    return {
      avg_stake_pct: 0,
      over_kelly_count: 0,
      compliance_rating: "N/A",
      message: "No bets with Kelly data in the last 30 days.",
    };
  }

  let totalStakePct = 0;
  let overKellyCount = 0;

  for (const row of rows) {
    const stakePct =
      currentBankroll > 0
        ? (parseFloat(row.stake) / currentBankroll) * 100
        : 0;
    totalStakePct += stakePct;

    // If stake exceeds recommended Kelly, count it
    const kellyFraction = parseFloat(row.kelly_fraction);
    if (stakePct > kellyFraction * 100 * 1.5) {
      overKellyCount++;
    }
  }

  const avgStakePct = totalStakePct / rows.length;
  const overKellyPct = (overKellyCount / rows.length) * 100;

  let rating: string;
  let message: string;
  if (overKellyPct < 5) {
    rating = "Excellent";
    message = "Disciplined sizing. Staying within Kelly recommendations.";
  } else if (overKellyPct < 15) {
    rating = "Good";
    message = "Mostly within Kelly limits. Minor over-sizing on some bets.";
  } else if (overKellyPct < 30) {
    rating = "Fair";
    message = "Frequently over-sizing bets beyond Kelly recommendation. Risk of ruin is elevated.";
  } else {
    rating = "Poor";
    message = "Significant over-betting. Consider reducing stake sizes to protect bankroll.";
  }

  return {
    avg_stake_pct: parseFloat(avgStakePct.toFixed(2)),
    over_kelly_count: overKellyCount,
    compliance_rating: rating,
    message,
  };
}

// ── Handle bankroll actions ──────────────────────────────────────────────────

async function handleBankrollAction(
  action: string,
  amount: number,
  note?: string
): Promise<BankrollResult> {
  if (amount <= 0 && action !== "set_balance") {
    throw new Error("Amount must be positive.");
  }

  let newBalance: number;

  if (action === "set_balance") {
    newBalance = amount;
  } else {
    const latest = await queryOne<{ balance: string }>(
      `SELECT balance FROM bankroll_ledger ORDER BY created_at DESC LIMIT 1`
    );
    const currentBalance = latest ? parseFloat(latest.balance) : 0;

    if (action === "deposit") {
      newBalance = currentBalance + amount;
    } else {
      // withdraw
      newBalance = currentBalance - amount;
      if (newBalance < 0) {
        throw new Error(
          `Insufficient balance. Current: $${currentBalance.toFixed(2)}, Withdrawal: $${amount.toFixed(2)}`
        );
      }
    }
  }

  await query(
    `INSERT INTO bankroll_ledger (balance, action, amount, note) VALUES ($1, $2, $3, $4)`,
    [newBalance, action, amount, note ?? null]
  );

  return {
    action_result: `${action}: $${amount.toFixed(2)}. New balance: $${newBalance.toFixed(2)}.`,
    message: `Bankroll ${action} recorded. New balance: $${newBalance.toFixed(2)}.`,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildStatusMessage(
  balance: number,
  drawdown: number,
  profit: number,
  roi: number
): string {
  let msg = `Bankroll: $${balance.toFixed(2)}`;
  if (profit >= 0) {
    msg += ` (+$${profit.toFixed(2)}, ${roi}% ROI)`;
  } else {
    msg += ` (-$${Math.abs(profit).toFixed(2)}, ${roi}% ROI)`;
  }
  if (drawdown > 10) {
    msg += ` ⚠️ ${drawdown}% drawdown from peak — consider reducing stake sizes.`;
  } else if (drawdown > 5) {
    msg += ` Note: ${drawdown}% drawdown from peak.`;
  }
  return msg;
}
