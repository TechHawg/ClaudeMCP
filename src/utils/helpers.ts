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

// ── No-vig (de-juiced) probabilities ─────────────────────────────────────────

/**
 * Strip vig from a 2-way market. Both prices are American odds for the
 * two opposing sides of the same market. Returns the no-vig (fair) probability
 * of side A. The no-vig probability of side B is (1 - returnedValue).
 *
 * Formula: noVig_A = impliedProb_A / (impliedProb_A + impliedProb_B)
 */
export function noVigProb2Way(
  americanA: number,
  americanB: number
): DecimalType {
  const pA = americanToImpliedProb(americanA);
  const pB = americanToImpliedProb(americanB);
  const overround = pA.plus(pB);
  if (overround.lte(0)) return new Decimal(0.5);
  return pA.div(overround);
}

/**
 * Strip vig from an n-way market (e.g., 3-way moneyline with draw).
 * Returns the no-vig probability for each side, in the same order as the input.
 */
export function noVigProbsNWay(americanOdds: number[]): DecimalType[] {
  const probs = americanOdds.map((o) => americanToImpliedProb(o));
  const overround = probs.reduce((s, p) => s.plus(p), new Decimal(0));
  if (overround.lte(0)) return probs.map(() => new Decimal(1).div(probs.length));
  return probs.map((p) => p.div(overround));
}

/**
 * Compute no-vig fair odds (American) for side A given both sides' American odds.
 * This is the "true" line stripped of bookmaker juice.
 */
export function noVigFairOddsAmerican(
  americanA: number,
  americanB: number
): number {
  const noVigA = noVigProb2Way(americanA, americanB);
  if (noVigA.lte(0) || noVigA.gte(1)) return americanA;
  const fairDecimal = new Decimal(1).div(noVigA);
  return decimalToAmerican(fairDecimal);
}

/**
 * Multi-book consensus no-vig probability.
 * Given an array of (priceA, priceB) tuples — one per sharp book — returns the
 * median no-vig probability for side A. More robust than any single book.
 * Returns null if no valid pairs are provided.
 */
export function multiBookConsensusNoVig(
  pairs: Array<{ priceA: number; priceB: number; book?: string }>
): { medianProbA: DecimalType; sampleSize: number; books: string[] } | null {
  const valid = pairs.filter(
    (p) => Number.isFinite(p.priceA) && Number.isFinite(p.priceB)
  );
  if (valid.length === 0) return null;
  const probs = valid
    .map((p) => noVigProb2Way(p.priceA, p.priceB).toNumber())
    .sort((a, b) => a - b);
  const mid = Math.floor(probs.length / 2);
  const median =
    probs.length % 2 === 0
      ? (probs[mid - 1] + probs[mid]) / 2
      : probs[mid];
  return {
    medianProbA: new Decimal(median),
    sampleSize: valid.length,
    books: valid.map((p) => p.book ?? "unknown"),
  };
}

/**
 * Compute true EV% given a fair (no-vig) probability and the offered American odds.
 * EV% = (fairProb * decimalOdds - 1) * 100.
 * This is the only correct EV formula — anything that uses a juiced probability
 * (raw Pinnacle implied prob) systematically inflates EV by ~half-the-vig.
 */
export function trueEvPercent(
  fairProb: DecimalType | number,
  americanOdds: number
): number {
  const p = typeof fairProb === "number" ? new Decimal(fairProb) : fairProb;
  const dec = americanToDecimal(americanOdds);
  return p.times(dec).minus(1).times(100).toDecimalPlaces(3).toNumber();
}

// ── Data Quality Flags ───────────────────────────────────────────────────────

/**
 * DataQuality describes the provenance of a signal so downstream consumers
 * (Claude, confidence scorer) can decide how much to trust it.
 *  - real:     measured from a reliable API or your own logged data
 *  - inferred: derived from a heuristic (e.g., sharp % from line divergence)
 *  - prior:    hardcoded default / unvalidated estimate (treat as a prior)
 *  - missing:  data unavailable; signal absent
 */
export type DataQuality = "real" | "inferred" | "prior" | "missing";

export interface QualifiedSignal<T> {
  value: T;
  data_quality: DataQuality;
  source: string;
  sample_size?: number;
  notes?: string;
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
