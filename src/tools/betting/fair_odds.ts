/**
 * No-vig fair odds — explicit endpoint for the multi-book sharp consensus.
 * Useful as a building block: "what does the sharp market think this side is worth?"
 */

import { getLiveOdds } from "./odds.js";
import {
  multiBookConsensusNoVig,
  noVigFairOddsAmerican,
  type DataQuality,
} from "../../utils/helpers.js";

const SHARP_BOOKS = new Set([
  "pinnacle",
  "circasports",
  "circa",
  "bookmaker_eu",
  "bookmaker.eu",
  "betcris",
  "matchbook",
]);

export interface FairOddsResult {
  game: string;
  market: string;
  side: string;
  point?: number;
  fair_prob_pct: number;
  fair_odds_american: number;
  consensus_books: string[];
  consensus_sample_size: number;
  best_book_price: number;
  best_book: string;
  edge_pct: number;
  data_quality: DataQuality;
  notes: string[];
}

export async function getNoVigFairOdds(params: {
  sport: string;
  game: string;
  side: string;
  market?: string;
}): Promise<FairOddsResult | { error: string }> {
  const market = params.market ?? "h2h";
  const games = await getLiveOdds({ sport: params.sport, game: params.game, market });
  if (games.length === 0) return { error: "No game found for that filter." };

  // Pick the first game (caller should pass enough specificity).
  const game = games[0];

  // Build (priceA, priceB) pairs across sharp books for the side.
  // We need both sides at the same book to de-vig per book.
  interface Pair { priceA: number; priceB: number; book: string; point?: number }
  const pairs: Pair[] = [];

  for (const bm of game.bookmakers) {
    if (!SHARP_BOOKS.has(bm.bookmaker.toLowerCase())) continue;
    const target = bm.outcomes.find((o) =>
      o.name.toLowerCase().includes(params.side.toLowerCase())
    );
    if (!target) continue;
    const opposing = bm.outcomes.find((o) => {
      if (o.name === target.name) return false;
      if (target.point != null && o.point != null) {
        return Math.abs(o.point + target.point) < 0.01 ||
               Math.abs(o.point - target.point) < 0.01;
      }
      return true;
    });
    if (!opposing) continue;
    pairs.push({
      priceA: target.price,
      priceB: opposing.price,
      book: bm.bookmaker,
      point: target.point,
    });
  }

  if (pairs.length === 0) {
    return { error: "No sharp book prices for this market — cannot compute fair odds." };
  }

  const consensus = multiBookConsensusNoVig(pairs);
  if (!consensus) return { error: "Consensus computation failed." };

  // Find the best book price for the side across all books.
  let bestPrice = -Infinity;
  let bestBook = "";
  for (const bm of game.bookmakers) {
    const target = bm.outcomes.find((o) =>
      o.name.toLowerCase().includes(params.side.toLowerCase())
    );
    if (!target) continue;
    if (target.price > bestPrice) {
      bestPrice = target.price;
      bestBook = bm.bookmaker;
    }
  }

  const fairProbDecimal = consensus.medianProbA;
  const fairAmerican = noVigFairOddsAmerican(pairs[0].priceA, pairs[0].priceB);
  const edge = bestPrice !== -Infinity
    ? Number((fairProbDecimal.toNumber() * 100 - 100 / (bestPrice > 0 ? bestPrice / 100 + 1 : 100 / -bestPrice + 1) * 100).toFixed(3))
    : 0;

  // Recompute edge cleanly:
  const bookProb = bestPrice > 0 ? 100 / (bestPrice + 100) : -bestPrice / (-bestPrice + 100);
  const cleanEdgePct = (fairProbDecimal.toNumber() - bookProb) * 100;

  const notes: string[] = [];
  if (consensus.sampleSize === 1) {
    notes.push("Only one sharp book available — fair odds derived from single source.");
  }

  return {
    game: `${game.away_team} @ ${game.home_team}`,
    market,
    side: params.side,
    point: pairs[0].point,
    fair_prob_pct: Number((fairProbDecimal.toNumber() * 100).toFixed(2)),
    fair_odds_american: fairAmerican,
    consensus_books: consensus.books,
    consensus_sample_size: consensus.sampleSize,
    best_book_price: bestPrice === -Infinity ? 0 : bestPrice,
    best_book: bestBook,
    edge_pct: Number(cleanEdgePct.toFixed(3)),
    data_quality: "real",
    notes,
  };
}
