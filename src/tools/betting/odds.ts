/**
 * Live Odds + Best Line Finder
 * Uses The Odds API v4 — Free tier: 500 requests/month.
 * Endpoint: GET https://api.the-odds-api.com/v4/sports/{sport}/odds
 * Also identifies Pinnacle line as "sharp reference."
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
import { isDatabaseConfigured, query } from "../../db/client.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface BookmakerOdds {
  bookmaker: string;
  market: string;
  outcomes: OutcomeOdds[];
  last_update: string;
}

export interface OutcomeOdds {
  name: string;
  price: number; // American odds
  point?: number; // spread/total number
  decimal_odds: number;
  implied_prob: number;
}

export interface GameOdds {
  id: string;
  sport: string;
  home_team: string;
  away_team: string;
  commence_time: string;
  bookmakers: BookmakerOdds[];
  pinnacle_line?: BookmakerOdds;
  best_lines: Record<string, { book: string; price: number; point?: number }>;
  cached_at: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const BASE_URL = "https://api.the-odds-api.com/v4/sports";
const PINNACLE_KEY = "pinnacle";

// ── Implementation ───────────────────────────────────────────────────────────

export async function getLiveOdds(params: {
  sport: string;
  game?: string;
  market?: string;
}): Promise<GameOdds[]> {
  const apiKey = process.env.THE_ODDS_API_KEY;
  if (!apiKey) {
    throw new Error(
      "THE_ODDS_API_KEY not set. Get a free key (500 req/month) at https://the-odds-api.com/"
    );
  }

  const sportKey = resolveSportKey(params.sport);
  const market = params.market ?? "h2h";

  // Check cache
  const cacheKey = OddsCache.buildKey({ sportKey, market });
  const cached = oddsCache.get(cacheKey);
  if (cached) {
    let games = cached as unknown as GameOdds[];
    if (params.game) games = filterByTeam(games, params.game);
    return games;
  }

  try {
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

    const now = isoNow();
    const games: GameOdds[] = (resp.data ?? []).map(
      (event: Record<string, unknown>) => {
        const bookmakers = parseBookmakers(
          event.bookmakers as Record<string, unknown>[],
          market
        );
        const pinnacle = bookmakers.find(
          (b) => b.bookmaker.toLowerCase() === PINNACLE_KEY
        );
        const bestLines = computeBestLines(bookmakers);

        return {
          id: event.id as string,
          sport: sportKey,
          home_team: event.home_team as string,
          away_team: event.away_team as string,
          commence_time: event.commence_time as string,
          bookmakers,
          pinnacle_line: pinnacle,
          best_lines: bestLines,
          cached_at: now,
        };
      }
    );

    // Cache raw results
    oddsCache.set(cacheKey, games as unknown);

    // Record line history snapshots (fire-and-forget, non-blocking)
    recordLineHistory(games, market).catch((err) =>
      console.error("[LineHistory] Failed to record:", err)
    );

    // Log remaining quota
    const remaining = resp.headers["x-requests-remaining"];
    const used = resp.headers["x-requests-used"];
    if (remaining) {
      console.error(
        `[OddsAPI] Quota: ${used} used, ${remaining} remaining this month`
      );
    }

    if (params.game) return filterByTeam(games, params.game);
    return games;
  } catch (error) {
    throw new Error(formatApiError(error, "The Odds API"));
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseBookmakers(
  raw: Record<string, unknown>[],
  market: string
): BookmakerOdds[] {
  if (!raw) return [];
  return raw.map((bm) => {
    const markets = bm.markets as Record<string, unknown>[];
    const mkt = markets?.find(
      (m) => (m.key as string) === market
    );
    const outcomes: OutcomeOdds[] = ((mkt?.outcomes as Record<string, unknown>[]) ?? []).map(
      (o) => {
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
      }
    );

    return {
      bookmaker: bm.key as string,
      market,
      outcomes,
      last_update: (bm.last_update as string) ?? isoNow(),
    };
  });
}

function computeBestLines(
  bookmakers: BookmakerOdds[]
): Record<string, { book: string; price: number; point?: number }> {
  const best: Record<string, { book: string; price: number; point?: number }> =
    {};

  for (const bm of bookmakers) {
    for (const outcome of bm.outcomes) {
      const key = outcome.point != null
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

function filterByTeam(games: GameOdds[], teamFilter: string): GameOdds[] {
  const lower = teamFilter.toLowerCase();
  return games.filter(
    (g) =>
      g.home_team.toLowerCase().includes(lower) ||
      g.away_team.toLowerCase().includes(lower)
  );
}

// ── Line History Recording ───────────────────────────────────────────────────

/** Record a snapshot of every line from every book into line_history.
 *  Runs asynchronously and never blocks the main odds response. */
async function recordLineHistory(
  games: GameOdds[],
  market: string
): Promise<void> {
  if (!isDatabaseConfigured()) return;

  const values: unknown[][] = [];
  for (const game of games) {
    for (const bm of game.bookmakers) {
      for (const outcome of bm.outcomes) {
        values.push([
          game.id,
          bm.bookmaker,
          market,
          outcome.name,
          outcome.point ?? null,
          outcome.price,
        ]);
      }
    }
  }

  if (values.length === 0) return;

  // Batch insert — build a multi-row VALUES clause for efficiency
  const placeholders: string[] = [];
  const flatParams: unknown[] = [];
  let idx = 1;
  for (const row of values) {
    placeholders.push(
      `($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`
    );
    flatParams.push(...row);
  }

  await query(
    `INSERT INTO line_history (game_id, book, market, side, line, odds)
     VALUES ${placeholders.join(", ")}`,
    flatParams
  );

  console.error(
    `[LineHistory] Recorded ${values.length} line snapshots for ${games.length} games`
  );
}
