/**
 * Value Line Detection vs Pinnacle (sharp reference).
 * Compares every book's line against Pinnacle and flags value opportunities.
 */

import { getLiveOdds, type GameOdds } from "./odds.js";
import {
  americanToImpliedProb,
  americanToDecimal,
} from "../../utils/helpers.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ValueLine {
  game: string;
  side: string;
  point?: number;
  best_book: string;
  best_price: number;
  best_decimal: number;
  pinnacle_price: number;
  pinnacle_decimal: number;
  implied_prob_diff_pct: number; // positive means value
  ev_percentage: number;
  value_rating: number; // 1-10
  sharp_pct?: number;
}

export interface ValueScanResult {
  sport: string;
  market: string;
  value_lines: ValueLine[];
  games_scanned: number;
  cached_at: string;
}

// ── Implementation ───────────────────────────────────────────────────────────

export async function findValueLines(params: {
  sport: string;
  game?: string;
  bet_type?: string;
  side?: string;
}): Promise<ValueScanResult> {
  const market = params.bet_type ?? "h2h";
  const games = await getLiveOdds({
    sport: params.sport,
    game: params.game,
    market,
  });

  const valueLines: ValueLine[] = [];

  for (const game of games) {
    if (!game.pinnacle_line) continue;

    const pinnacleOutcomes = game.pinnacle_line.outcomes;

    for (const pOutcome of pinnacleOutcomes) {
      // Skip if user specified a side and this isn't it
      if (
        params.side &&
        !pOutcome.name.toLowerCase().includes(params.side.toLowerCase())
      ) {
        continue;
      }

      const pinnProb = americanToImpliedProb(pOutcome.price);
      const pinnDec = americanToDecimal(pOutcome.price);

      // Find best line across all books for this outcome
      for (const bm of game.bookmakers) {
        if (bm.bookmaker === "pinnacle") continue;

        const matching = bm.outcomes.find((o) => {
          if (o.name !== pOutcome.name) return false;
          // For spreads/totals, points must match (or be better)
          if (pOutcome.point != null && o.point != null) {
            return o.point === pOutcome.point;
          }
          return true;
        });

        if (!matching) continue;

        const bookProb = americanToImpliedProb(matching.price);
        const bookDec = americanToDecimal(matching.price);

        // Implied probability differential: positive = value on the book's line
        const diff = pinnProb.minus(bookProb).times(100);

        // Only flag if > 2% edge
        if (diff.gt(2)) {
          // EV = (trueProb * decimalOdds) - 1
          const ev = pinnProb
            .times(bookDec)
            .minus(1)
            .times(100)
            .toDecimalPlaces(2)
            .toNumber();

          const rating = computeValueRating(diff.toNumber());

          valueLines.push({
            game: `${game.away_team} @ ${game.home_team}`,
            side: matching.name,
            point: matching.point,
            best_book: bm.bookmaker,
            best_price: matching.price,
            best_decimal: bookDec.toDecimalPlaces(4).toNumber(),
            pinnacle_price: pOutcome.price,
            pinnacle_decimal: pinnDec.toDecimalPlaces(4).toNumber(),
            implied_prob_diff_pct: diff.toDecimalPlaces(2).toNumber(),
            ev_percentage: ev,
            value_rating: rating,
          });
        }
      }
    }
  }

  // Sort by value rating descending
  valueLines.sort((a, b) => b.value_rating - a.value_rating);

  return {
    sport: params.sport,
    market,
    value_lines: valueLines,
    games_scanned: games.length,
    cached_at: games[0]?.cached_at ?? new Date().toISOString(),
  };
}

function computeValueRating(diffPct: number): number {
  // 2% diff = 1, 10%+ diff = 10
  if (diffPct >= 10) return 10;
  if (diffPct <= 2) return 1;
  return Math.round(((diffPct - 2) / 8) * 9 + 1);
}
