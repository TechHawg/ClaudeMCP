/**
 * Live / In-Play Odds Tool
 * Filters to games currently in progress and flags value in live markets.
 * Uses The Odds API v4 with event status filtering.
 */

import axios from "axios";
import {
  resolveSportKey,
  americanToDecimal,
  americanToImpliedProb,
  formatApiError,
  isoNow,
} from "../../utils/helpers.js";
import { oddsCache, OddsCache } from "../../utils/cache.js";
import DecimalLib from "decimal.js";
const Decimal = DecimalLib.default ?? DecimalLib;

// ── Types ────────────────────────────────────────────────────────────────────

interface LiveOutcome {
  name: string;
  price: number;
  point?: number;
  decimal_odds: number;
  implied_prob: number;
}

interface LiveBookmaker {
  bookmaker: string;
  market: string;
  outcomes: LiveOutcome[];
  last_update: string;
}

interface LiveGame {
  id: string;
  sport: string;
  home_team: string;
  away_team: string;
  commence_time: string;
  is_live: boolean;
  bookmakers: LiveBookmaker[];
  pinnacle_line?: LiveBookmaker;
  best_lines: Record<string, { book: string; price: number; point?: number }>;
  live_value_alerts: LiveValueAlert[];
}

interface LiveValueAlert {
  side: string;
  book: string;
  price: number;
  pinnacle_price: number;
  edge_pct: number;
  message: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const BASE_URL = "https://api.the-odds-api.com/v4/sports";
const PINNACLE_KEY = "pinnacle";
const LIVE_VALUE_THRESHOLD = 3.0; // flag if 3%+ implied prob edge vs Pinnacle

// ── Implementation ───────────────────────────────────────────────────────────

export async function getLiveInPlayOdds(params: {
  sport: string;
  game?: string;
  market?: string;
}): Promise<{ live_games: LiveGame[]; pre_game_count: number; message: string }> {
  const apiKey = process.env.THE_ODDS_API_KEY;
  if (!apiKey) {
    throw new Error(
      "THE_ODDS_API_KEY not set. Get a free key (500 req/month) at https://the-odds-api.com/"
    );
  }

  const sportKey = resolveSportKey(params.sport);
  const market = params.market ?? "h2h";

  // Check cache (short 30s TTL for live data)
  const cacheKey = OddsCache.buildKey({ sportKey, market, extra: "live" });
  const cached = oddsCache.get(cacheKey);
  if (cached) {
    return cached as unknown as { live_games: LiveGame[]; pre_game_count: number; message: string };
  }

  try {
    // Fetch all events including live
    const resp = await axios.get(`${BASE_URL}/${sportKey}/odds`, {
      params: {
        apiKey,
        regions: "us,us2,eu",
        markets: market,
        oddsFormat: "american",
        includeLinks: false,
      },
      timeout: 20000,
    });

    const now = new Date();
    const allEvents = resp.data ?? [];
    let preGameCount = 0;

    const liveGames: LiveGame[] = [];

    for (const event of allEvents) {
      const commenceTime = new Date(event.commence_time as string);
      // An event is "live" if commence_time is in the past (game has started)
      const isLive = commenceTime <= now;

      if (!isLive) {
        preGameCount++;
        continue; // skip pre-game events
      }

      const bookmakers = parseBookmakers(
        event.bookmakers as Record<string, unknown>[],
        market
      );
      const pinnacle = bookmakers.find(
        (b) => b.bookmaker.toLowerCase() === PINNACLE_KEY
      );
      const bestLines = computeBestLines(bookmakers);
      const valueAlerts = findLiveValue(bookmakers, pinnacle);

      const game: LiveGame = {
        id: event.id as string,
        sport: sportKey,
        home_team: event.home_team as string,
        away_team: event.away_team as string,
        commence_time: event.commence_time as string,
        is_live: true,
        bookmakers,
        pinnacle_line: pinnacle,
        best_lines: bestLines,
        live_value_alerts: valueAlerts,
      };

      liveGames.push(game);
    }

    // Filter by team if specified
    let filtered = liveGames;
    if (params.game) {
      const teamLower = params.game.toLowerCase();
      filtered = liveGames.filter(
        (g) =>
          g.home_team.toLowerCase().includes(teamLower) ||
          g.away_team.toLowerCase().includes(teamLower)
      );
    }

    const result = {
      live_games: filtered,
      pre_game_count: preGameCount,
      message:
        filtered.length > 0
          ? `Found ${filtered.length} live game(s) with ${filtered.reduce((sum, g) => sum + g.live_value_alerts.length, 0)} value alert(s).`
          : `No live games found for ${params.sport}. ${preGameCount} pre-game events available — use get_live_odds for pre-game lines.`,
    };

    // Cache for 30 seconds (live data changes fast)
    oddsCache.set(cacheKey, result as unknown);

    // Log quota
    const remaining = resp.headers["x-requests-remaining"];
    if (remaining) {
      console.error(`[OddsAPI/Live] ${remaining} requests remaining`);
    }

    return result;
  } catch (error) {
    throw new Error(formatApiError(error, "The Odds API (Live)"));
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseBookmakers(
  raw: Record<string, unknown>[],
  market: string
): LiveBookmaker[] {
  if (!raw) return [];
  return raw.map((bm) => {
    const markets = bm.markets as Record<string, unknown>[];
    const mkt = markets?.find((m) => (m.key as string) === market);
    const outcomes: LiveOutcome[] = (
      (mkt?.outcomes as Record<string, unknown>[]) ?? []
    ).map((o) => {
      const price = o.price as number;
      const dec = americanToDecimal(price);
      return {
        name: o.name as string,
        price,
        point: o.point as number | undefined,
        decimal_odds: dec.toDecimalPlaces(4).toNumber(),
        implied_prob: americanToImpliedProb(price)
          .times(100)
          .toDecimalPlaces(2)
          .toNumber(),
      };
    });

    return {
      bookmaker: bm.key as string,
      market,
      outcomes,
      last_update: (bm.last_update as string) ?? isoNow(),
    };
  });
}

function computeBestLines(
  bookmakers: LiveBookmaker[]
): Record<string, { book: string; price: number; point?: number }> {
  const best: Record<string, { book: string; price: number; point?: number }> = {};
  for (const bm of bookmakers) {
    for (const outcome of bm.outcomes) {
      const key =
        outcome.point != null
          ? `${outcome.name}|${outcome.point}`
          : outcome.name;
      if (!best[key] || outcome.price > best[key].price) {
        best[key] = {
          book: bm.bookmaker,
          price: outcome.price,
          point: outcome.point,
        };
      }
    }
  }
  return best;
}

function findLiveValue(
  bookmakers: LiveBookmaker[],
  pinnacle?: LiveBookmaker
): LiveValueAlert[] {
  if (!pinnacle) return [];

  const alerts: LiveValueAlert[] = [];
  const pinnacleProbs: Record<string, number> = {};
  for (const o of pinnacle.outcomes) {
    pinnacleProbs[o.name] = o.implied_prob;
  }

  for (const bm of bookmakers) {
    if (bm.bookmaker.toLowerCase() === PINNACLE_KEY) continue;
    for (const o of bm.outcomes) {
      const pinProb = pinnacleProbs[o.name];
      if (pinProb === undefined) continue;

      const edge = pinProb - o.implied_prob;
      if (edge >= LIVE_VALUE_THRESHOLD) {
        const pinOutcome = pinnacle.outcomes.find((po) => po.name === o.name);
        alerts.push({
          side: o.name,
          book: bm.bookmaker,
          price: o.price,
          pinnacle_price: pinOutcome?.price ?? 0,
          edge_pct: parseFloat(edge.toFixed(2)),
          message: `${o.name} at ${bm.bookmaker} (${o.price > 0 ? "+" : ""}${o.price}) has ${edge.toFixed(1)}% edge vs Pinnacle — live market may be slow to adjust.`,
        });
      }
    }
  }

  return alerts.sort((a, b) => b.edge_pct - a.edge_pct);
}
