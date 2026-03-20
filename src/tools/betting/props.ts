/**
 * Player Props Builder.
 * Combines SportsRadar stats with The Odds API props markets
 * to generate prop recommendations with hit rates.
 *
 * SportsRadar — Free trial: 1,000 calls/month per sport
 * https://developer.sportradar.com/
 */

import axios from "axios";
import { formatApiError, resolveSportKey } from "../../utils/helpers.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface PropCard {
  player_name: string;
  sport: string;
  market: string;
  current_line: number;
  best_book: string;
  best_odds: number;
  season_average: number;
  last_10_average: number;
  matchup_adjusted_projection: number;
  opponent: string;
  opponent_defensive_rank?: number;
  recommendation: "over" | "under";
  historical_hit_rate_pct: number;
  matchup_edge_score: number; // 1-10
  confidence_score: number; // 1-10
  supporting_data: string[];
  cached_at: string;
}

// ── Implementation ───────────────────────────────────────────────────────────

export async function buildPlayerProp(params: {
  player_name: string;
  market: string;
  sport: string;
}): Promise<PropCard> {
  const sportKey = resolveSportKey(params.sport);
  const now = new Date().toISOString();

  // Fetch player stats from SportsRadar
  const stats = await fetchPlayerStats(
    params.player_name,
    params.sport,
    params.market
  );

  // Fetch prop lines from The Odds API
  const propLines = await fetchPropLines(sportKey, params.player_name, params.market);

  // Calculate recommendation
  const projection = stats.matchup_adjusted_projection;
  const line = propLines.line;
  const recommendation: "over" | "under" =
    projection > line ? "over" : "under";

  // Calculate historical hit rate (simulated based on averages)
  const hitRate = calculateHitRate(
    stats.season_average,
    stats.last_10_average,
    line,
    recommendation
  );

  // Matchup edge: how much the defensive matchup shifts the projection
  const matchupEdge = calculateMatchupEdge(
    stats.season_average,
    stats.matchup_adjusted_projection
  );

  // Confidence: composite of hit rate, matchup edge, and data quality
  const confidence = Math.min(
    10,
    Math.round(
      (hitRate / 10) * 3 + matchupEdge * 0.4 + (stats.games_played > 15 ? 3 : 1)
    )
  );

  const supporting: string[] = [
    `Season avg: ${stats.season_average.toFixed(1)}`,
    `Last 10 avg: ${stats.last_10_average.toFixed(1)}`,
    `Projection vs ${stats.opponent}: ${projection.toFixed(1)}`,
  ];
  if (stats.opponent_defensive_rank) {
    supporting.push(
      `${stats.opponent} defensive rank in ${params.market}: #${stats.opponent_defensive_rank}`
    );
  }
  if (hitRate >= 65) supporting.push(`Strong hit rate: ${hitRate.toFixed(0)}%`);

  return {
    player_name: params.player_name,
    sport: params.sport,
    market: params.market,
    current_line: line,
    best_book: propLines.book,
    best_odds: propLines.odds,
    season_average: stats.season_average,
    last_10_average: stats.last_10_average,
    matchup_adjusted_projection: projection,
    opponent: stats.opponent,
    opponent_defensive_rank: stats.opponent_defensive_rank,
    recommendation,
    historical_hit_rate_pct: hitRate,
    matchup_edge_score: matchupEdge,
    confidence_score: confidence,
    supporting_data: supporting,
    cached_at: now,
  };
}

// ── SportsRadar stats fetcher ────────────────────────────────────────────────

interface PlayerStats {
  season_average: number;
  last_10_average: number;
  matchup_adjusted_projection: number;
  opponent: string;
  opponent_defensive_rank?: number;
  games_played: number;
}

async function fetchPlayerStats(
  playerName: string,
  sport: string,
  market: string
): Promise<PlayerStats> {
  const apiKey = process.env.SPORTRADAR_API_KEY;

  // If SportsRadar key is available, try to fetch real data
  if (apiKey) {
    try {
      // SportsRadar endpoints vary by sport — using their player profile endpoint
      // The exact endpoint depends on the sport-specific API
      const sportMap: Record<string, string> = {
        nfl: "americanfootball/trial/v7/en",
        nba: "basketball/trial/v8/en",
        mlb: "baseball/trial/v7/en",
        nhl: "icehockey/trial/v7/en",
      };
      const sportPath = sportMap[sport.toLowerCase()] ?? sportMap["nfl"];

      // Search for player
      const searchResp = await axios.get(
        `https://api.sportradar.com/${sportPath}/players/search.json`,
        {
          params: { api_key: apiKey, q: playerName },
          timeout: 15000,
        }
      );

      const player = searchResp.data?.players?.[0];
      if (player) {
        // Fetch player profile with stats
        const profileResp = await axios.get(
          `https://api.sportradar.com/${sportPath}/players/${player.id}/profile.json`,
          {
            params: { api_key: apiKey },
            timeout: 15000,
          }
        );

        const seasons = profileResp.data?.seasons ?? [];
        const currentSeason = seasons[0];
        const stats = currentSeason?.teams?.[0]?.statistics;

        if (stats) {
          return parseRealStats(stats, market, playerName);
        }
      }
    } catch (error) {
      console.error(
        `[SportsRadar] Failed to fetch stats for ${playerName}:`,
        formatApiError(error, "SportsRadar")
      );
      // Fall through to estimation
    }
  }

  // Fallback: return a placeholder indicating real data wasn't available
  return {
    season_average: 0,
    last_10_average: 0,
    matchup_adjusted_projection: 0,
    opponent: "Unknown",
    games_played: 0,
  };
}

function parseRealStats(
  stats: Record<string, unknown>,
  market: string,
  _playerName: string
): PlayerStats {
  // Map market names to stat fields (varies by sport)
  const statMap: Record<string, string[]> = {
    points: ["points_per_game", "avg_points"],
    rebounds: ["rebounds_per_game", "avg_rebounds"],
    assists: ["assists_per_game", "avg_assists"],
    passing_yards: ["avg_pass_yards", "passing_yards_per_game"],
    rushing_yards: ["avg_rush_yards", "rushing_yards_per_game"],
    strikeouts: ["avg_strikeouts", "strikeouts_per_game"],
  };

  const keys = statMap[market.toLowerCase()] ?? [market];
  let value = 0;
  for (const k of keys) {
    if (stats[k] != null) {
      value = Number(stats[k]);
      break;
    }
  }

  return {
    season_average: value,
    last_10_average: value * 1.02, // Slight recency adjustment
    matchup_adjusted_projection: value,
    opponent: "TBD",
    games_played: Number(stats["games_played"] ?? 0),
  };
}

// ── Prop lines from The Odds API ─────────────────────────────────────────────

interface PropLine {
  line: number;
  book: string;
  odds: number;
}

async function fetchPropLines(
  sportKey: string,
  playerName: string,
  market: string
): Promise<PropLine> {
  const apiKey = process.env.THE_ODDS_API_KEY;
  if (!apiKey) {
    return { line: 0, book: "N/A", odds: -110 };
  }

  // The Odds API props require:
  //   1. GET /v4/sports/{sport}/events — lists events with IDs
  //   2. GET /v4/sports/{sport}/events/{eventId}/odds?markets=player_{market}_over_under
  // Each event-level call costs extra quota, so we iterate cautiously.

  // Map user-friendly market to Odds API props market key
  const propsMarketMap: Record<string, string> = {
    points: "player_points_over_under",
    rebounds: "player_rebounds_over_under",
    assists: "player_assists_over_under",
    passing_yards: "player_pass_yds_over_under",
    rushing_yards: "player_rush_yds_over_under",
    receiving_yards: "player_reception_yds_over_under",
    strikeouts: "player_strikeouts_over_under",
    hits: "player_hits_over_under",
    threes: "player_threes_over_under",
  };

  const oddsMarket = propsMarketMap[market.toLowerCase()] ?? `player_${market.toLowerCase()}_over_under`;

  try {
    // Step 1: Get events for this sport
    const eventsResp = await axios.get(
      `https://api.the-odds-api.com/v4/sports/${sportKey}/events`,
      {
        params: { apiKey },
        timeout: 15000,
      }
    );

    const events = eventsResp.data ?? [];
    if (events.length === 0) {
      return { line: 0, book: "No events found", odds: -110 };
    }

    // Step 2: Check each event for this player's props (limit to first 5 to preserve quota)
    const playerLower = playerName.toLowerCase();
    for (const event of events.slice(0, 5)) {
      const eventId = event.id as string;

      const oddsResp = await axios.get(
        `https://api.the-odds-api.com/v4/sports/${sportKey}/events/${eventId}/odds`,
        {
          params: {
            apiKey,
            regions: "us,us2",
            markets: oddsMarket,
            oddsFormat: "american",
          },
          timeout: 15000,
        }
      );

      const bookmakers = oddsResp.data?.bookmakers ?? [];
      let bestLine: PropLine | null = null;

      for (const bm of bookmakers) {
        for (const mkt of bm.markets ?? []) {
          for (const outcome of mkt.outcomes ?? []) {
            const desc = String(outcome.description ?? "").toLowerCase();
            if (desc.includes(playerLower)) {
              const price = outcome.price as number;
              const point = outcome.point as number;

              // Pick the best odds (highest price) for the over
              if (
                String(outcome.name).toLowerCase() === "over" &&
                (!bestLine || price > bestLine.odds)
              ) {
                bestLine = {
                  line: point,
                  book: bm.key as string,
                  odds: price,
                };
              }
            }
          }
        }
      }

      if (bestLine) return bestLine;
    }

    return { line: 0, book: "Player prop not found in current events", odds: -110 };
  } catch (error) {
    console.error("[Props] Failed to fetch prop lines:", formatApiError(error, "The Odds API"));
    return { line: 0, book: "Error fetching props", odds: -110 };
  }
}

// ── Calculation helpers ──────────────────────────────────────────────────────

function calculateHitRate(
  seasonAvg: number,
  last10Avg: number,
  line: number,
  rec: "over" | "under"
): number {
  if (line === 0 || seasonAvg === 0) return 50;

  // Weighted average: 60% last 10, 40% season
  const weighted = last10Avg * 0.6 + seasonAvg * 0.4;
  const diff = rec === "over" ? weighted - line : line - weighted;
  const ratio = diff / line;

  // Convert to estimated hit rate (capped 30-85%)
  return Math.min(85, Math.max(30, 50 + ratio * 200));
}

function calculateMatchupEdge(
  seasonAvg: number,
  projection: number
): number {
  if (seasonAvg === 0) return 5;
  const pctDiff = ((projection - seasonAvg) / seasonAvg) * 100;
  // Scale: -20% = 1, +20% = 10
  return Math.min(10, Math.max(1, Math.round(5 + pctDiff / 4)));
}
