/**
 * Futures & Outrights Tool
 * Fetches championship, division, and award futures markets.
 * Uses The Odds API v4 outrights endpoint.
 */

import axios from "axios";
import {
  americanToDecimal,
  americanToImpliedProb,
  formatApiError,
  isoNow,
} from "../../utils/helpers.js";
import { oddsCache, OddsCache } from "../../utils/cache.js";
import DecimalLib from "decimal.js";
const Decimal = DecimalLib.default ?? DecimalLib;

// ── Types ────────────────────────────────────────────────────────────────────

interface FuturesOutcome {
  name: string;
  price: number; // American odds
  decimal_odds: number;
  implied_prob: number;
}

interface FuturesMarket {
  bookmaker: string;
  outcomes: FuturesOutcome[];
  last_update: string;
}

interface FuturesResult {
  sport: string;
  event_name: string;
  id: string;
  commence_time: string;
  markets: FuturesMarket[];
  best_odds: Record<string, { book: string; price: number; implied_prob: number }>;
  cached_at: string;
}

// ── Outrights sport keys ─────────────────────────────────────────────────────

const FUTURES_SPORT_MAP: Record<string, string[]> = {
  nfl: [
    "americanfootball_nfl_super_bowl_winner",
    "americanfootball_nfl_conference_winner",
    "americanfootball_nfl_division_winner",
  ],
  nba: [
    "basketball_nba_championship_winner",
    "basketball_nba_conference_winner",
    "basketball_nba_division_winner",
  ],
  mlb: [
    "baseball_mlb_world_series_winner",
    "baseball_mlb_pennant_winner",
    "baseball_mlb_division_winner",
  ],
  nhl: [
    "icehockey_nhl_stanley_cup_winner",
    "icehockey_nhl_conference_winner",
    "icehockey_nhl_division_winner",
  ],
  ncaaf: ["americanfootball_ncaaf_championship_winner"],
  ncaab: ["basketball_ncaab_championship_winner"],
};

const BASE_URL = "https://api.the-odds-api.com/v4/sports";

// ── Implementation ───────────────────────────────────────────────────────────

export async function getFutures(params: {
  sport: string;
  market_type?: string; // "championship", "conference", "division"
  team?: string;
}): Promise<FuturesResult[]> {
  const apiKey = process.env.THE_ODDS_API_KEY;
  if (!apiKey) {
    throw new Error(
      "THE_ODDS_API_KEY not set. Get a free key (500 req/month) at https://the-odds-api.com/"
    );
  }

  const sportLower = params.sport.toLowerCase().trim();
  const sportKeys = FUTURES_SPORT_MAP[sportLower];
  if (!sportKeys) {
    throw new Error(
      `No futures markets for "${params.sport}". Valid: ${Object.keys(FUTURES_SPORT_MAP).join(", ")}`
    );
  }

  // Filter by market type if specified
  let keysToFetch = sportKeys;
  if (params.market_type) {
    const mt = params.market_type.toLowerCase();
    keysToFetch = sportKeys.filter((k) => k.includes(mt));
    if (keysToFetch.length === 0) {
      keysToFetch = sportKeys; // fall back to all
    }
  }

  const results: FuturesResult[] = [];

  for (const sportKey of keysToFetch) {
    // Check cache
    const cacheKey = OddsCache.buildKey({ sportKey, market: "outrights" });
    const cached = oddsCache.get(cacheKey);
    if (cached) {
      const cachedResults = cached as unknown as FuturesResult[];
      results.push(...cachedResults);
      continue;
    }

    try {
      const resp = await axios.get(`${BASE_URL}/${sportKey}/odds`, {
        params: {
          apiKey,
          regions: "us,us2,eu",
          oddsFormat: "american",
        },
        timeout: 20000,
      });

      const now = isoNow();
      const events: FuturesResult[] = (resp.data ?? []).map(
        (event: Record<string, unknown>) => {
          const rawBookmakers = event.bookmakers as Record<string, unknown>[];
          const markets: FuturesMarket[] = (rawBookmakers ?? []).map((bm) => {
            const bmMarkets = bm.markets as Record<string, unknown>[];
            const mkt = bmMarkets?.[0]; // outrights typically have one market
            const outcomes: FuturesOutcome[] = (
              (mkt?.outcomes as Record<string, unknown>[]) ?? []
            ).map((o) => {
              const price = o.price as number;
              const dec = americanToDecimal(price);
              return {
                name: o.name as string,
                price,
                decimal_odds: dec.toDecimalPlaces(4).toNumber(),
                implied_prob: americanToImpliedProb(price)
                  .times(100)
                  .toDecimalPlaces(2)
                  .toNumber(),
              };
            });

            return {
              bookmaker: bm.key as string,
              outcomes,
              last_update: (bm.last_update as string) ?? now,
            };
          });

          // Compute best odds per team across all books
          const bestOdds: Record<string, { book: string; price: number; implied_prob: number }> = {};
          for (const m of markets) {
            for (const o of m.outcomes) {
              if (!bestOdds[o.name] || o.price > bestOdds[o.name].price) {
                bestOdds[o.name] = {
                  book: m.bookmaker,
                  price: o.price,
                  implied_prob: o.implied_prob,
                };
              }
            }
          }

          return {
            sport: sportKey,
            event_name: (event.description as string) ?? sportKey,
            id: event.id as string,
            commence_time: event.commence_time as string,
            markets,
            best_odds: bestOdds,
            cached_at: now,
          };
        }
      );

      // Cache
      oddsCache.set(cacheKey, events as unknown);
      results.push(...events);

      // Log quota
      const remaining = resp.headers["x-requests-remaining"];
      if (remaining) {
        console.error(`[OddsAPI/Futures] ${remaining} requests remaining`);
      }
    } catch (error) {
      console.error(
        `[Futures] Failed to fetch ${sportKey}:`,
        formatApiError(error, "The Odds API")
      );
    }
  }

  // Filter by team if specified
  if (params.team) {
    const teamLower = params.team.toLowerCase();
    for (const r of results) {
      r.markets = r.markets.map((m) => ({
        ...m,
        outcomes: m.outcomes.filter((o) =>
          o.name.toLowerCase().includes(teamLower)
        ),
      }));
      // Filter best_odds too
      const filtered: typeof r.best_odds = {};
      for (const [name, val] of Object.entries(r.best_odds)) {
        if (name.toLowerCase().includes(teamLower)) {
          filtered[name] = val;
        }
      }
      r.best_odds = filtered;
    }
  }

  return results;
}
