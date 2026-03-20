/**
 * Shared utility functions for the Betting MCP Server.
 */

import DecimalLib from "decimal.js";
const Decimal = DecimalLib.default ?? DecimalLib;
type DecimalType = InstanceType<typeof Decimal>;

// ── Constants ────────────────────────────────────────────────────────────────

export const CHARACTER_LIMIT = 50000;

export const SUPPORTED_SPORTS = [
  "americanfootball_nfl",
  "americanfootball_ncaaf",
  "basketball_nba",
  "basketball_ncaab",
  "baseball_mlb",
  "icehockey_nhl",
  "soccer_epl",
  "soccer_spain_la_liga",
  "soccer_italy_serie_a",
  "soccer_germany_bundesliga",
  "soccer_france_ligue_one",
  "soccer_usa_mls",
  "soccer_uefa_champs_league",
  "golf_pga_championship",
  "golf_masters_tournament",
  "golf_the_open_championship",
  "golf_us_open",
] as const;

export type SportKey = (typeof SUPPORTED_SPORTS)[number] | string;

/** Map user-friendly sport names to The Odds API sport keys */
export const SPORT_ALIAS: Record<string, string> = {
  nfl: "americanfootball_nfl",
  ncaaf: "americanfootball_ncaaf",
  nba: "basketball_nba",
  ncaab: "basketball_ncaab",
  ncaamb: "basketball_ncaab",
  mlb: "baseball_mlb",
  nhl: "icehockey_nhl",
  // Soccer leagues
  soccer: "soccer_epl",
  epl: "soccer_epl",
  "premier league": "soccer_epl",
  "la liga": "soccer_spain_la_liga",
  "serie a": "soccer_italy_serie_a",
  bundesliga: "soccer_germany_bundesliga",
  "ligue 1": "soccer_france_ligue_one",
  mls: "soccer_usa_mls",
  "champions league": "soccer_uefa_champs_league",
  ucl: "soccer_uefa_champs_league",
  // Golf tournaments
  golf: "golf_pga_championship",
  pga: "golf_pga_championship",
  masters: "golf_masters_tournament",
  "the open": "golf_the_open_championship",
  "us open golf": "golf_us_open",
};

export function resolveSportKey(input: string): SportKey {
  const lower = input.toLowerCase().trim();
  if (SPORT_ALIAS[lower]) return SPORT_ALIAS[lower];
  const direct = SUPPORTED_SPORTS.find((s) => s === lower);
  if (direct) return direct;
  // Allow pass-through for any Odds API sport key (e.g. "soccer_brazil_campeonato")
  if (lower.includes("_")) return lower;
  throw new Error(
    `Unknown sport "${input}". Valid: ${Object.keys(SPORT_ALIAS).join(", ")}`
  );
}

// ── Odds conversion (precise decimal arithmetic) ─────────────────────────────

/** Convert American odds to decimal odds using Decimal.js for precision */
export function americanToDecimal(american: number): DecimalType {
  if (american > 0) {
    return new Decimal(american).div(100).plus(1);
  }
  return new Decimal(100).div(new Decimal(american).abs()).plus(1);
}

/** Convert decimal odds to implied probability */
export function decimalToImpliedProb(decimalOdds: DecimalType): DecimalType {
  return new Decimal(1).div(decimalOdds);
}

/** Convert American odds directly to implied probability */
export function americanToImpliedProb(american: number): DecimalType {
  return decimalToImpliedProb(americanToDecimal(american));
}

/** Convert decimal odds to American odds */
export function decimalToAmerican(dec: DecimalType): number {
  if (dec.gte(2)) {
    return dec.minus(1).times(100).toDecimalPlaces(0).toNumber();
  }
  return new Decimal(-100)
    .div(dec.minus(1))
    .toDecimalPlaces(0)
    .toNumber();
}

// ── Kelly Criterion ──────────────────────────────────────────────────────────

export interface KellyResult {
  kellyPercentage: number;
  recommendedBet: number;
  riskAssessment: "low" | "medium" | "high" | "extreme";
  fullKellyPct: number;
}

export function kellyBetSize(
  bankroll: number,
  edgePct: number,
  decimalOdds: number,
  kellyFraction: number = 0.25
): KellyResult {
  const edge = new Decimal(edgePct).div(100);
  const odds = new Decimal(decimalOdds);
  const b = odds.minus(1); // net odds (payout on $1 bet)
  const p = new Decimal(1).div(odds).plus(edge); // estimated true probability
  const q = new Decimal(1).minus(p);

  // Kelly formula: f* = (bp - q) / b
  let fullKelly = b.times(p).minus(q).div(b);
  if (fullKelly.isNeg()) fullKelly = new Decimal(0);

  const fractionalKelly = fullKelly.times(kellyFraction);
  const bet = new Decimal(bankroll).times(fractionalKelly);

  const pct = fractionalKelly.times(100).toDecimalPlaces(2).toNumber();
  let risk: KellyResult["riskAssessment"] = "low";
  if (pct > 10) risk = "extreme";
  else if (pct > 5) risk = "high";
  else if (pct > 2) risk = "medium";

  return {
    kellyPercentage: pct,
    recommendedBet: bet.toDecimalPlaces(2).toNumber(),
    riskAssessment: risk,
    fullKellyPct: fullKelly.times(100).toDecimalPlaces(2).toNumber(),
  };
}

// ── API error formatting ─────────────────────────────────────────────────────

export function formatApiError(error: unknown, apiName: string): string {
  if (error instanceof Error) {
    const axiosErr = error as unknown as Record<string, unknown>;
    if (axiosErr.response && typeof axiosErr.response === "object") {
      const resp = axiosErr.response as { status?: number; data?: unknown };
      if (resp.status === 401)
        return `Error: ${apiName} authentication failed — check your API key.`;
      if (resp.status === 403)
        return `Error: ${apiName} access denied — your plan may not include this endpoint.`;
      if (resp.status === 429)
        return `Error: ${apiName} rate limit exceeded — wait before retrying.`;
      if (resp.status === 422)
        return `Error: ${apiName} invalid request parameters: ${JSON.stringify(resp.data)}`;
      return `Error: ${apiName} returned status ${resp.status}: ${JSON.stringify(resp.data)}`;
    }
    if (axiosErr.code === "ECONNABORTED")
      return `Error: ${apiName} request timed out — try again.`;
    return `Error: ${apiName} — ${error.message}`;
  }
  return `Error: ${apiName} — unexpected error: ${String(error)}`;
}

// ── Timestamp helpers ────────────────────────────────────────────────────────

export function isoNow(): string {
  return new Date().toISOString();
}

export function secondsAgo(isoDate: string): number {
  return Math.floor((Date.now() - new Date(isoDate).getTime()) / 1000);
}

// ── Response truncation ──────────────────────────────────────────────────────

export function truncateIfNeeded(text: string): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  return (
    text.slice(0, CHARACTER_LIMIT) +
    "\n\n[Response truncated — use more specific filters to reduce result size]"
  );
}
