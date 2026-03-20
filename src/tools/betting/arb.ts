/**
 * Arbitrage + Middle Detector.
 * Scans all markets across all books for guaranteed profit opportunities.
 */

import DecimalLib from "decimal.js";
const Decimal = DecimalLib.default ?? DecimalLib;
import { getLiveOdds, type GameOdds } from "./odds.js";
import { americanToDecimal } from "../../utils/helpers.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ArbOpportunity {
  type: "arbitrage" | "middle";
  game: string;
  market: string;
  side_a: { name: string; book: string; odds: number; point?: number };
  side_b: { name: string; book: string; odds: number; point?: number };
  profit_pct: number;
  bet_a_pct: number; // % of total stake on side A
  bet_b_pct: number;
  bet_a_amount: number; // for $1000 total stake
  bet_b_amount: number;
  middle_window?: string; // e.g. "if total lands between 47 and 48.5"
}

export interface ArbScanResult {
  sport: string;
  opportunities: ArbOpportunity[];
  games_scanned: number;
  markets_checked: number;
  cached_at: string;
}

// ── Implementation ───────────────────────────────────────────────────────────

export async function detectArbitrage(params: {
  sport: string;
  game?: string;
  stake?: number;
}): Promise<ArbScanResult> {
  const totalStake = params.stake ?? 1000;
  const markets = ["h2h", "spreads", "totals"];
  const opportunities: ArbOpportunity[] = [];
  let marketsChecked = 0;
  let gamesScanned = 0;

  for (const market of markets) {
    const games = await getLiveOdds({
      sport: params.sport,
      game: params.game,
      market,
    });

    if (market === "h2h") gamesScanned = games.length;
    marketsChecked++;

    for (const game of games) {
      // Find best odds for each outcome across all books
      const bestByOutcome = new Map<
        string,
        { book: string; odds: number; point?: number; name: string }
      >();

      for (const bm of game.bookmakers) {
        for (const outcome of bm.outcomes) {
          const key =
            outcome.point != null
              ? `${outcome.name}|${outcome.point}`
              : outcome.name;

          const existing = bestByOutcome.get(key);
          if (!existing || outcome.price > existing.odds) {
            bestByOutcome.set(key, {
              book: bm.bookmaker,
              odds: outcome.price,
              point: outcome.point,
              name: outcome.name,
            });
          }
        }
      }

      // Check for 2-way arbs (h2h/totals: 2 outcomes)
      const outcomes = Array.from(bestByOutcome.values());

      if (market === "h2h" || market === "totals") {
        // 2-way market
        if (outcomes.length >= 2) {
          for (let i = 0; i < outcomes.length; i++) {
            for (let j = i + 1; j < outcomes.length; j++) {
              const arb = checkTwoWayArb(
                outcomes[i],
                outcomes[j],
                `${game.away_team} @ ${game.home_team}`,
                market,
                totalStake
              );
              if (arb) opportunities.push(arb);
            }
          }
        }
      }

      // Check for middles on spreads and totals
      if (market === "spreads" || market === "totals") {
        const middles = findMiddles(game, market, totalStake);
        opportunities.push(...middles);
      }
    }
  }

  // Sort by profit descending
  opportunities.sort((a, b) => b.profit_pct - a.profit_pct);

  return {
    sport: params.sport,
    opportunities,
    games_scanned: gamesScanned,
    markets_checked: marketsChecked,
    cached_at: new Date().toISOString(),
  };
}

// ── Arb calculation ──────────────────────────────────────────────────────────

function checkTwoWayArb(
  a: { book: string; odds: number; point?: number; name: string },
  b: { book: string; odds: number; point?: number; name: string },
  game: string,
  market: string,
  totalStake: number
): ArbOpportunity | null {
  const decA = americanToDecimal(a.odds);
  const decB = americanToDecimal(b.odds);

  // Arb exists if 1/decA + 1/decB < 1
  const impliedSum = new Decimal(1).div(decA).plus(new Decimal(1).div(decB));

  if (impliedSum.lt(1)) {
    const profitPct = new Decimal(1)
      .div(impliedSum)
      .minus(1)
      .times(100)
      .toDecimalPlaces(2)
      .toNumber();

    // Calculate bet amounts
    const betAPct = new Decimal(1)
      .div(decA)
      .div(impliedSum)
      .times(100)
      .toDecimalPlaces(2)
      .toNumber();
    const betBPct = new Decimal(100).minus(betAPct).toDecimalPlaces(2).toNumber();

    return {
      type: "arbitrage",
      game,
      market,
      side_a: { name: a.name, book: a.book, odds: a.odds, point: a.point },
      side_b: { name: b.name, book: b.book, odds: b.odds, point: b.point },
      profit_pct: profitPct,
      bet_a_pct: betAPct,
      bet_b_pct: betBPct,
      bet_a_amount: new Decimal(totalStake)
        .times(betAPct)
        .div(100)
        .toDecimalPlaces(2)
        .toNumber(),
      bet_b_amount: new Decimal(totalStake)
        .times(betBPct)
        .div(100)
        .toDecimalPlaces(2)
        .toNumber(),
    };
  }

  return null;
}

// ── Middle detection ─────────────────────────────────────────────────────────

function findMiddles(
  game: GameOdds,
  market: string,
  totalStake: number
): ArbOpportunity[] {
  const middles: ArbOpportunity[] = [];

  // Collect all outcomes with points, grouped by side name
  const outcomeSides = new Map<
    string,
    { book: string; odds: number; point: number }[]
  >();

  for (const bm of game.bookmakers) {
    for (const outcome of bm.outcomes) {
      if (outcome.point == null) continue;
      const key = outcome.name;
      if (!outcomeSides.has(key)) outcomeSides.set(key, []);
      outcomeSides.get(key)!.push({
        book: bm.bookmaker,
        odds: outcome.price,
        point: outcome.point,
      });
    }
  }

  // For spreads/totals, look for line discrepancies that create a middle
  const sides = Array.from(outcomeSides.keys());

  if (sides.length >= 2) {
    const sideA = sides[0];
    const sideB = sides[1];
    const aOptions = outcomeSides.get(sideA) ?? [];
    const bOptions = outcomeSides.get(sideB) ?? [];

    // Find the widest middle window
    for (const a of aOptions) {
      for (const b of bOptions) {
        // Middle exists when e.g. TeamA -3.5 at one book, TeamB +4.5 at another
        // The actual "point" values should create a gap
        const gap = Math.abs(a.point) - Math.abs(b.point);

        if (gap > 0 && gap <= 3) {
          // There's a middle window
          middles.push({
            type: "middle",
            game: `${game.away_team} @ ${game.home_team}`,
            market,
            side_a: {
              name: sideA,
              book: a.book,
              odds: a.odds,
              point: a.point,
            },
            side_b: {
              name: sideB,
              book: b.book,
              odds: b.odds,
              point: b.point,
            },
            profit_pct: 0, // Middle profit depends on where the number lands
            bet_a_pct: 50,
            bet_b_pct: 50,
            bet_a_amount: totalStake / 2,
            bet_b_amount: totalStake / 2,
            middle_window: `If result lands between ${Math.min(Math.abs(a.point), Math.abs(b.point))} and ${Math.max(Math.abs(a.point), Math.abs(b.point))}, both sides win`,
          });
        }
      }
    }
  }

  return middles;
}
