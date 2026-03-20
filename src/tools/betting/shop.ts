/**
 * Line Shopping Tool
 * Takes a specific game + side + market and returns a sorted table
 * of every book's price with the mathematical edge of each vs Pinnacle.
 * Uses The Odds API v4.
 */

import { getLiveOdds, type GameOdds, type BookmakerOdds } from "./odds.js";
import {
  americanToDecimal,
  americanToImpliedProb,
  decimalToAmerican,
} from "../../utils/helpers.js";
import DecimalLib from "decimal.js";
const Decimal = DecimalLib.default ?? DecimalLib;

// ── Types ────────────────────────────────────────────────────────────────────

interface ShopLineResult {
  book: string;
  price: number; // American odds
  decimal_odds: number;
  implied_prob: number;
  edge_vs_pinnacle: number; // percentage points
  ev_percentage: number;
  rank: number;
}

interface ShopResult {
  game: string;
  side: string;
  market: string;
  pinnacle_price: number | null;
  pinnacle_implied_prob: number | null;
  lines: ShopLineResult[];
  best_book: string | null;
  best_price: number | null;
  worst_book: string | null;
  worst_price: number | null;
  price_spread: number; // difference between best and worst in implied prob
  recommendation: string;
}

// ── Implementation ───────────────────────────────────────────────────────────

export async function shopLines(params: {
  sport: string;
  game: string;
  side: string;
  market?: string;
}): Promise<ShopResult> {
  const market = params.market ?? "h2h";

  // Fetch odds for this sport/game
  const games = await getLiveOdds({
    sport: params.sport,
    game: params.game,
    market,
  });

  if (games.length === 0) {
    throw new Error(
      `No games found matching "${params.game}" for ${params.sport}. ` +
        `Make sure the game hasn't started yet and the team name is correct.`
    );
  }

  // Use the first matching game
  const gameData = games[0];
  const sideLower = params.side.toLowerCase();

  // Find Pinnacle's line for this side
  let pinnaclePrice: number | null = null;
  let pinnacleImplied: number | null = null;
  if (gameData.pinnacle_line) {
    const pinOutcome = gameData.pinnacle_line.outcomes.find(
      (o) => o.name.toLowerCase().includes(sideLower)
    );
    if (pinOutcome) {
      pinnaclePrice = pinOutcome.price;
      pinnacleImplied = pinOutcome.implied_prob;
    }
  }

  // Collect every book's price for this side
  const lines: ShopLineResult[] = [];
  for (const bm of gameData.bookmakers) {
    const outcome = bm.outcomes.find(
      (o) => o.name.toLowerCase().includes(sideLower)
    );
    if (!outcome) continue;

    const dec = americanToDecimal(outcome.price);
    const impl = americanToImpliedProb(outcome.price);
    const implPct = impl.times(100).toDecimalPlaces(2).toNumber();

    let edgeVsPinnacle = 0;
    let evPct = 0;
    if (pinnacleImplied !== null) {
      // Edge = Pinnacle implied prob - this book's implied prob
      // Positive means this book is offering better odds than Pinnacle
      edgeVsPinnacle = new Decimal(pinnacleImplied)
        .minus(implPct)
        .toDecimalPlaces(2)
        .toNumber();

      // EV% = (trueProbability * decimalOdds) - 1, using Pinnacle as true prob
      const trueProb = new Decimal(pinnacleImplied).div(100);
      evPct = trueProb
        .times(dec)
        .minus(1)
        .times(100)
        .toDecimalPlaces(2)
        .toNumber();
    }

    lines.push({
      book: bm.bookmaker,
      price: outcome.price,
      decimal_odds: dec.toDecimalPlaces(4).toNumber(),
      implied_prob: implPct,
      edge_vs_pinnacle: edgeVsPinnacle,
      ev_percentage: evPct,
      rank: 0, // will be set after sorting
    });
  }

  // Sort by price descending (best odds first)
  lines.sort((a, b) => b.price - a.price);
  lines.forEach((l, i) => (l.rank = i + 1));

  const best = lines[0] ?? null;
  const worst = lines[lines.length - 1] ?? null;
  const priceSpread =
    best && worst
      ? new Decimal(worst.implied_prob)
          .minus(best.implied_prob)
          .abs()
          .toDecimalPlaces(2)
          .toNumber()
      : 0;

  // Build recommendation
  let recommendation = "No lines available.";
  if (best && pinnaclePrice !== null) {
    if (best.ev_percentage > 3) {
      recommendation = `Strong value at ${best.book} (${best.price > 0 ? "+" : ""}${best.price}). EV: +${best.ev_percentage}% vs Pinnacle. This is a clear bet.`;
    } else if (best.ev_percentage > 0) {
      recommendation = `Slight value at ${best.book} (${best.price > 0 ? "+" : ""}${best.price}). EV: +${best.ev_percentage}% vs Pinnacle. Consider if other signals align.`;
    } else {
      recommendation = `No positive EV found vs Pinnacle. Best available: ${best.book} at ${best.price > 0 ? "+" : ""}${best.price}.`;
    }
  } else if (best) {
    recommendation = `Best price: ${best.book} at ${best.price > 0 ? "+" : ""}${best.price}. Pinnacle line unavailable for edge comparison.`;
  }

  if (priceSpread > 5) {
    recommendation += ` Note: ${priceSpread}% implied prob spread across books — significant line discrepancy.`;
  }

  return {
    game: `${gameData.away_team} @ ${gameData.home_team}`,
    side: params.side,
    market,
    pinnacle_price: pinnaclePrice,
    pinnacle_implied_prob: pinnacleImplied,
    lines,
    best_book: best?.book ?? null,
    best_price: best?.price ?? null,
    worst_book: worst?.book ?? null,
    worst_price: worst?.price ?? null,
    price_spread: priceSpread,
    recommendation,
  };
}
