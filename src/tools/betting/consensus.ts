/**
 * Consensus Picks Aggregator
 * Fetches public betting percentages and consensus picks.
 * Tries ActionNetwork API first, falls back to analyzing sharp vs public book divergence.
 */

import axios from "axios";
import { getLiveOdds, type GameOdds } from "./odds.js";
import {
  resolveSportKey,
  formatApiError,
  americanToImpliedProb,
} from "../../utils/helpers.js";
import DecimalLib from "decimal.js";
const Decimal = DecimalLib.default ?? DecimalLib;

// ── Types ────────────────────────────────────────────────────────────────────

interface ConsensusGame {
  game: string;
  market: string;
  sides: ConsensusSide[];
  sharp_vs_public: SharpPublicDivergence | null;
  recommendation: string;
}

interface ConsensusSide {
  name: string;
  public_bet_pct: number; // % of bets
  public_money_pct: number; // % of money
  line: number; // current line (American)
  implied_prob: number;
  source: string;
}

interface SharpPublicDivergence {
  sharp_side: string;
  public_side: string;
  sharp_price: number;
  public_avg_price: number;
  divergence_pct: number;
  is_rlm: boolean; // reverse line movement indicator
  message: string;
}

interface ConsensusResult {
  sport: string;
  games: ConsensusGame[];
  fade_public_opportunities: ConsensusGame[];
  message: string;
}

// ── Sharp vs Public books ────────────────────────────────────────────────────

const SHARP_BOOKS = ["pinnacle", "circa", "bookmaker", "betcris"];
const PUBLIC_BOOKS = ["draftkings", "fanduel", "betmgm", "caesars", "pointsbet", "wynnbet"];

// ── Implementation ───────────────────────────────────────────────────────────

export async function getConsensusPicks(params: {
  sport: string;
  game?: string;
  market?: string;
}): Promise<ConsensusResult> {
  const sport = params.sport;
  const market = params.market ?? "h2h";

  // Try ActionNetwork API first
  const actionNetworkKey = process.env.ACTION_NETWORK_API_KEY;
  if (actionNetworkKey) {
    try {
      return await fetchActionNetworkConsensus(sport, market, params.game);
    } catch (error) {
      console.error(
        "[Consensus] ActionNetwork failed, falling back to book divergence:",
        error
      );
    }
  }

  // Fallback: analyze sharp vs public book divergence
  return analyzeBookDivergence(sport, market, params.game);
}

// ── ActionNetwork consensus ──────────────────────────────────────────────────

async function fetchActionNetworkConsensus(
  sport: string,
  market: string,
  gameFilter?: string
): Promise<ConsensusResult> {
  const apiKey = process.env.ACTION_NETWORK_API_KEY!;
  const sportKey = resolveSportKey(sport);

  // ActionNetwork public endpoints for consensus data
  const resp = await axios.get(
    `https://api.actionnetwork.com/web/v1/scoreboard/${sportKey}`,
    {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 15000,
    }
  );

  const events = resp.data?.games ?? resp.data?.events ?? [];
  const games: ConsensusGame[] = [];

  for (const event of events) {
    const gameName = `${event.away_team?.full_name ?? event.away_team} @ ${event.home_team?.full_name ?? event.home_team}`;

    if (gameFilter && !gameName.toLowerCase().includes(gameFilter.toLowerCase())) {
      continue;
    }

    const odds = event.odds ?? [];
    const consensusData = odds[0]?.consensus ?? null;

    if (!consensusData) continue;

    const sides: ConsensusSide[] = [];
    if (consensusData.home) {
      sides.push({
        name: event.home_team?.full_name ?? "Home",
        public_bet_pct: consensusData.home.bet_pct ?? 50,
        public_money_pct: consensusData.home.money_pct ?? 50,
        line: consensusData.home.line ?? 0,
        implied_prob: 0,
        source: "ActionNetwork",
      });
    }
    if (consensusData.away) {
      sides.push({
        name: event.away_team?.full_name ?? "Away",
        public_bet_pct: consensusData.away.bet_pct ?? 50,
        public_money_pct: consensusData.away.money_pct ?? 50,
        line: consensusData.away.line ?? 0,
        implied_prob: 0,
        source: "ActionNetwork",
      });
    }

    // Calculate implied probs
    for (const side of sides) {
      if (side.line !== 0) {
        side.implied_prob = americanToImpliedProb(side.line)
          .times(100)
          .toDecimalPlaces(1)
          .toNumber();
      }
    }

    const recommendation = buildRecommendation(sides);

    games.push({
      game: gameName,
      market,
      sides,
      sharp_vs_public: null,
      recommendation,
    });
  }

  const fadeOpps = games.filter((g) =>
    g.sides.some((s) => s.public_bet_pct > 70)
  );

  return {
    sport,
    games,
    fade_public_opportunities: fadeOpps,
    message: `${games.length} game(s) with consensus data. ${fadeOpps.length} potential fade-the-public opportunities (>70% public on one side).`,
  };
}

// ── Book divergence analysis (fallback) ──────────────────────────────────────

async function analyzeBookDivergence(
  sport: string,
  market: string,
  gameFilter?: string
): Promise<ConsensusResult> {
  const odds = await getLiveOdds({ sport, game: gameFilter, market });

  const games: ConsensusGame[] = [];

  for (const gameData of odds) {
    const gameName = `${gameData.away_team} @ ${gameData.home_team}`;

    // Separate sharp and public book odds
    const sharpBooks = gameData.bookmakers.filter((bm) =>
      SHARP_BOOKS.some((sb) => bm.bookmaker.toLowerCase().includes(sb))
    );
    const publicBooks = gameData.bookmakers.filter((bm) =>
      PUBLIC_BOOKS.some((pb) => bm.bookmaker.toLowerCase().includes(pb))
    );

    if (sharpBooks.length === 0 || publicBooks.length === 0) continue;

    // Get all unique sides
    const allSides = new Set<string>();
    for (const bm of gameData.bookmakers) {
      for (const o of bm.outcomes) {
        allSides.add(o.name);
      }
    }

    const sides: ConsensusSide[] = [];
    let divergence: SharpPublicDivergence | null = null;

    for (const sideName of allSides) {
      // Average sharp price
      const sharpPrices: number[] = [];
      for (const bm of sharpBooks) {
        const o = bm.outcomes.find((x) => x.name === sideName);
        if (o) sharpPrices.push(o.price);
      }

      // Average public price
      const publicPrices: number[] = [];
      for (const bm of publicBooks) {
        const o = bm.outcomes.find((x) => x.name === sideName);
        if (o) publicPrices.push(o.price);
      }

      if (sharpPrices.length === 0 || publicPrices.length === 0) continue;

      const avgSharp = sharpPrices.reduce((a, b) => a + b, 0) / sharpPrices.length;
      const avgPublic = publicPrices.reduce((a, b) => a + b, 0) / publicPrices.length;

      // Estimate public bet % based on how public books are shaded
      // If public books have shorter odds (more negative/less positive) on a side,
      // it suggests more public money is on that side
      const sharpImplied = americanToImpliedProb(Math.round(avgSharp))
        .times(100)
        .toNumber();
      const publicImplied = americanToImpliedProb(Math.round(avgPublic))
        .times(100)
        .toNumber();

      // Public books shade their lines toward the public side
      // Higher implied prob on public books = more public money on that side
      const publicBias = publicImplied - sharpImplied;
      const estimatedPublicPct = Math.min(
        90,
        Math.max(10, 50 + publicBias * 5)
      );

      sides.push({
        name: sideName,
        public_bet_pct: parseFloat(estimatedPublicPct.toFixed(0)),
        public_money_pct: parseFloat(estimatedPublicPct.toFixed(0)),
        line: Math.round(avgPublic),
        implied_prob: parseFloat(publicImplied.toFixed(1)),
        source: "Book divergence estimate",
      });
    }

    // Find biggest divergence
    if (sides.length >= 2) {
      sides.sort((a, b) => b.public_bet_pct - a.public_bet_pct);
      const publicSide = sides[0];
      const sharpSide = sides[sides.length - 1];

      const divPct = publicSide.public_bet_pct - sharpSide.public_bet_pct;
      if (divPct > 15) {
        divergence = {
          sharp_side: sharpSide.name,
          public_side: publicSide.name,
          sharp_price: sharpSide.line,
          public_avg_price: publicSide.line,
          divergence_pct: parseFloat(divPct.toFixed(1)),
          is_rlm: false, // Would need line history to determine
          message: `Public heavy on ${publicSide.name} (~${publicSide.public_bet_pct}%). Sharp books lean ${sharpSide.name}. Divergence: ${divPct.toFixed(0)}%.`,
        };
      }
    }

    const recommendation = buildRecommendation(sides);

    games.push({
      game: gameName,
      market,
      sides,
      sharp_vs_public: divergence,
      recommendation,
    });
  }

  const fadeOpps = games.filter(
    (g) => g.sharp_vs_public && g.sharp_vs_public.divergence_pct > 20
  );

  return {
    sport,
    games,
    fade_public_opportunities: fadeOpps,
    message:
      `${games.length} game(s) analyzed via sharp/public book divergence. ` +
      `${fadeOpps.length} significant divergence(s) found. ` +
      (process.env.ACTION_NETWORK_API_KEY
        ? ""
        : "Tip: Set ACTION_NETWORK_API_KEY for actual bet/money percentages."),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildRecommendation(sides: ConsensusSide[]): string {
  if (sides.length < 2) return "Insufficient data for recommendation.";

  const heavySide = sides.find((s) => s.public_bet_pct > 70);
  if (heavySide) {
    return `Public is heavily on ${heavySide.name} (${heavySide.public_bet_pct}%). Historical data shows fading heavy public sides is profitable long-term. Consider the other side if other signals (sharp money, CLV, situational) align.`;
  }

  const balanced = sides.every(
    (s) => s.public_bet_pct > 35 && s.public_bet_pct < 65
  );
  if (balanced) {
    return "Balanced action. No strong public lean — look for edge from other signals.";
  }

  return "Moderate public lean. Use in combination with other tools for a full picture.";
}
