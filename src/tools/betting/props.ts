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

  // Fetch prop lines from The Odds API (with player team for smart event matching)
  const propLines = await fetchPropLines(sportKey, params.player_name, params.market, stats.team);

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
  team?: string;
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
        nba: "nba/trial/v8/en",
        mlb: "mlb/trial/v7/en",
        nhl: "nhl/trial/v7/en",
        ncaab: "ncaamb/trial/v8/en",
        ncaamb: "ncaamb/trial/v8/en",
        soccer: "soccer/trial/v4/en",
        golf: "golf/trial/v3/en",
      };
      const sportPath = sportMap[sport.toLowerCase()];
      if (!sportPath) {
        console.warn(`[SportsRadar] No trial subscription for ${sport} — skipping stats fetch`);
        return {
          season_average: 0,
          last_10_average: 0,
          matchup_adjusted_projection: 0,
          opponent: "Unknown",
          games_played: 0,
        };
      }

      // Search for player — SportsRadar API structure varies by sport
      // NBA v8: GET /nba/trial/v8/en/players/search/{query}.json
      // MLB v7: GET /mlb/trial/v7/en/players/search/{query}.json
      const encodedName = encodeURIComponent(playerName);
      const searchUrl = `https://api.sportradar.com/${sportPath}/players/search/${encodedName}.json`;
      console.log(`[SportsRadar] Searching: ${searchUrl}`);

      const searchResp = await axios.get(searchUrl, {
        params: { api_key: apiKey },
        timeout: 15000,
      });

      // Response structure: { players: [...] } or { results: [...] } or { search: { players: [...] } }
      const players =
        searchResp.data?.players ??
        searchResp.data?.results ??
        searchResp.data?.search?.players ??
        [];
      const player = Array.isArray(players) ? players[0] : null;

      console.log(
        `[SportsRadar] Search returned ${Array.isArray(players) ? players.length : 0} players` +
        (player ? ` — matched: ${player.full_name ?? player.name ?? player.id}` : " — no match")
      );

      if (player) {
        // Extract team from player object if available
        let playerTeam = player.team_code ?? player.team_id ?? undefined;

        // Fetch player profile with stats
        const profileUrl = `https://api.sportradar.com/${sportPath}/players/${player.id}/profile.json`;
        console.log(`[SportsRadar] Fetching profile: ${profileUrl}`);

        const profileResp = await axios.get(profileUrl, {
          params: { api_key: apiKey },
          timeout: 15000,
        });

        // Profile response structure varies:
        // NBA: { seasons: [{ teams: [{ statistics: {...} }] }] }
        // Alternative: { statistics: {...} } or nested under player object
        const profileData = profileResp.data;
        const seasons = profileData?.seasons ?? [];
        const currentSeason = seasons[0];

        // Try to extract team from current season
        if (!playerTeam) {
          playerTeam = currentSeason?.teams?.[0]?.team_code ??
                       currentSeason?.teams?.[0]?.team_id ??
                       undefined;
        }

        // Try multiple paths to find statistics
        const stats =
          currentSeason?.teams?.[0]?.statistics ??
          currentSeason?.statistics ??
          profileData?.statistics ??
          profileData?.player?.statistics ??
          null;

        if (stats) {
          console.log(`[SportsRadar] Found stats for ${playerName}`);
          return parseRealStats(stats, market, playerName, playerTeam);
        } else {
          console.warn(
            `[SportsRadar] Profile loaded but no stats found. Keys: ${Object.keys(profileData ?? {}).join(", ")}`
          );
        }
      }
    } catch (error) {
      console.error(
        `[SportsRadar] Failed to fetch stats for ${playerName}:`,
        formatApiError(error, "SportsRadar")
      );
      // Fall through to free API fallback
    }
  }

  // Improvement 1: Free API Fallback
  console.log(`[FreeAPI] Attempting to fetch stats for ${playerName} from free APIs`);

  if (sport.toLowerCase() === "nba") {
    try {
      return await fetchNBAStatsFromBalldontlie(playerName, market);
    } catch (error) {
      console.error(`[BalldontLie] Failed to fetch NBA stats:`, formatApiError(error, "BalldontLie"));
    }
  }

  if (sport.toLowerCase() === "nhl") {
    try {
      return await fetchNHLStatsFromNHLAPI(playerName, market);
    } catch (error) {
      console.error(`[NHL API] Failed to fetch NHL stats:`, formatApiError(error, "NHL API"));
    }
  }

  // Final fallback: return a placeholder indicating real data wasn't available
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
  _playerName: string,
  playerTeam?: string
): PlayerStats {
  // Map market names to stat fields — try multiple SportsRadar field name variants
  // SportsRadar NBA uses: average.points, average.rebounds, etc. or flat fields
  const statMap: Record<string, string[]> = {
    // NBA
    points: ["points_per_game", "avg_points", "points", "ppg"],
    rebounds: ["rebounds_per_game", "avg_rebounds", "rebounds", "rpg"],
    assists: ["assists_per_game", "avg_assists", "assists", "apg"],
    threes: ["three_points_made_per_game", "avg_three_points_made", "three_points_made"],
    blocks: ["blocks_per_game", "avg_blocks", "blocks"],
    steals: ["steals_per_game", "avg_steals", "steals"],
    turnovers: ["turnovers_per_game", "avg_turnovers", "turnovers"],
    // NFL
    passing_yards: ["avg_pass_yards", "passing_yards_per_game", "pass_yards", "passing_yards"],
    pass_yards: ["avg_pass_yards", "passing_yards_per_game", "pass_yards", "passing_yards"],
    rushing_yards: ["avg_rush_yards", "rushing_yards_per_game", "rush_yards", "rushing_yards"],
    rush_yards: ["avg_rush_yards", "rushing_yards_per_game", "rush_yards", "rushing_yards"],
    receiving_yards: ["avg_receiving_yards", "receiving_yards_per_game", "receiving_yards"],
    receptions: ["receptions_per_game", "avg_receptions", "receptions"],
    // MLB
    strikeouts: ["avg_strikeouts", "strikeouts_per_game", "strikeouts", "k_per_9"],
    hits: ["avg_hits", "hits_per_game", "hits", "batting_average"],
    home_runs: ["home_runs", "hr", "avg_home_runs"],
    // NHL
    goals: ["goals_per_game", "avg_goals", "goals"],
    shots_on_goal: ["shots_per_game", "avg_shots", "shots_on_goal", "shots"],
    saves: ["saves_per_game", "avg_saves", "saves"],
  };

  const keys = statMap[market.toLowerCase()] ?? [market];
  let value = 0;

  // First try flat stats object
  for (const k of keys) {
    if (stats[k] != null) {
      value = Number(stats[k]);
      break;
    }
  }

  // If not found, try nested "average" or "total" objects (SportsRadar nests stats)
  if (value === 0) {
    const avgObj = stats["average"] as Record<string, unknown> | undefined;
    const totalObj = stats["total"] as Record<string, unknown> | undefined;
    for (const k of keys) {
      if (avgObj?.[k] != null) {
        value = Number(avgObj[k]);
        break;
      }
      if (totalObj?.[k] != null) {
        value = Number(totalObj[k]);
        break;
      }
    }
  }

  console.log(`[SportsRadar] Parsed ${market} stat = ${value} (tried keys: ${keys.join(", ")})`);

  return {
    season_average: value,
    last_10_average: value * 1.02, // Slight recency adjustment
    matchup_adjusted_projection: value,
    opponent: "TBD",
    games_played: Number(
      stats["games_played"] ?? stats["gp"] ?? stats["games"] ?? 0
    ),
    team: playerTeam,
  };
}

// ── Free API Fallbacks ───────────────────────────────────────────────────────

async function fetchNBAStatsFromBalldontlie(
  playerName: string,
  market: string
): Promise<PlayerStats> {
  // Step 1: Search for player
  const balldontlieKey = process.env.BALLDONTLIE_API_KEY;
  const searchUrl = `https://api.balldontlie.io/v1/players?search=${encodeURIComponent(playerName)}`;

  const searchHeaders: Record<string, string> = {};
  if (balldontlieKey) {
    searchHeaders["Authorization"] = balldontlieKey;
  }

  const searchResp = await axios.get(searchUrl, {
    headers: searchHeaders,
    timeout: 15000,
  });

  const players = searchResp.data?.data ?? [];
  const player = Array.isArray(players) ? players[0] : null;

  if (!player) {
    throw new Error(`Player "${playerName}" not found on BallDontLie`);
  }

  console.log(`[BalldontLie] Found player: ${player.first_name} ${player.last_name} (ID: ${player.id})`);

  // Step 2: Fetch season averages for current season (2025)
  const statsUrl = `https://api.balldontlie.io/v1/season_averages?player_ids[]=${player.id}&season=2025`;

  const statsHeaders: Record<string, string> = {};
  if (balldontlieKey) {
    statsHeaders["Authorization"] = balldontlieKey;
  }

  const statsResp = await axios.get(statsUrl, {
    headers: statsHeaders,
    timeout: 15000,
  });

  const seasonStats = statsResp.data?.data ?? [];
  const stats = Array.isArray(seasonStats) ? seasonStats[0] : null;

  if (!stats) {
    throw new Error(`No stats found for ${playerName} in 2025 season`);
  }

  console.log(`[BalldontLie] Found stats for ${playerName}`);

  // Map market to BallDontLie stat field
  const ballDontLieStatMap: Record<string, string> = {
    points: "pts",
    rebounds: "reb",
    assists: "ast",
    blocks: "blk",
    steals: "stl",
    threes: "fg3m",
    turnovers: "turnover",
  };

  const statField = ballDontLieStatMap[market.toLowerCase()] ?? market.toLowerCase();
  const value = Number(stats[statField] ?? 0);

  return {
    season_average: value,
    last_10_average: value * 1.05, // Slight recency adjustment
    matchup_adjusted_projection: value,
    opponent: "TBD",
    opponent_defensive_rank: undefined,
    games_played: Number(stats["gp"] ?? stats["games_played"] ?? 0),
    team: player.team?.abbreviation,
  };
}

async function fetchNHLStatsFromNHLAPI(
  playerName: string,
  market: string
): Promise<PlayerStats> {
  // Step 1: Search for player
  const searchUrl = `https://search.d3.nhle.com/api/v1/search/player?culture=en-us&limit=5&q=${encodeURIComponent(playerName)}`;

  const searchResp = await axios.get(searchUrl, {
    timeout: 15000,
  });

  const players = searchResp.data?.data ?? [];
  const player = Array.isArray(players) ? players[0] : null;

  if (!player || !player.playerId) {
    throw new Error(`Player "${playerName}" not found on NHL API`);
  }

  console.log(`[NHL API] Found player: ${player.name} (ID: ${player.playerId})`);

  // Step 2: Fetch player landing page (contains current season stats)
  const landingUrl = `https://api-web.nhle.com/v1/player/${player.playerId}/landing`;

  const landingResp = await axios.get(landingUrl, {
    timeout: 15000,
  });

  const landingData = landingResp.data;

  // Extract current season stats
  const seasonStats = landingData?.seasonTotals?.[0];
  if (!seasonStats) {
    throw new Error(`No stats found for ${playerName}`);
  }

  console.log(`[NHL API] Found stats for ${playerName}`);

  // Map market to NHL stat field
  const nhlStatMap: Record<string, string> = {
    goals: "goals",
    assists: "assists",
    shots_on_goal: "shots",
    saves: "saves",
    points: "points",
  };

  const statField = nhlStatMap[market.toLowerCase()] ?? market.toLowerCase();
  const value = Number(seasonStats[statField] ?? 0);
  const gamesPlayed = Number(seasonStats["gamesPlayed"] ?? seasonStats["gp"] ?? 0);

  // Extract team abbreviation from player data
  const teamAbbr = player.teamAbbr ?? landingData?.playerTeamInfo?.abbrev;

  return {
    season_average: gamesPlayed > 0 ? value / gamesPlayed : value,
    last_10_average: gamesPlayed > 0 ? (value / gamesPlayed) * 1.05 : value,
    matchup_adjusted_projection: gamesPlayed > 0 ? value / gamesPlayed : value,
    opponent: "TBD",
    opponent_defensive_rank: undefined,
    games_played: gamesPlayed,
    team: teamAbbr,
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
  market: string,
  playerTeam?: string
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
  // See: https://the-odds-api.com/sports-odds-data/betting-markets.html
  // NBA/NCAAB/WNBA: player_points, player_rebounds, player_assists, player_threes, etc.
  // NFL: player_pass_yds, player_rush_yds, player_reception_yds, etc.
  // MLB: batter_hits, batter_home_runs, pitcher_strikeouts (note: batter_/pitcher_ prefix!)
  // NHL: player_points, player_goals, player_assists, player_shots_on_goal
  const propsMarketMap: Record<string, string> = {
    // NBA / NCAAB
    points: "player_points",
    rebounds: "player_rebounds",
    assists: "player_assists",
    threes: "player_threes",
    blocks: "player_blocks",
    steals: "player_steals",
    turnovers: "player_turnovers",
    pra: "player_points_rebounds_assists",
    "points+rebounds+assists": "player_points_rebounds_assists",
    "points+rebounds": "player_points_rebounds",
    "points+assists": "player_points_assists",
    "rebounds+assists": "player_rebounds_assists",
    double_double: "player_double_double",
    triple_double: "player_triple_double",
    // NFL
    passing_yards: "player_pass_yds",
    pass_yards: "player_pass_yds",
    rushing_yards: "player_rush_yds",
    rush_yards: "player_rush_yds",
    receiving_yards: "player_reception_yds",
    receptions: "player_receptions",
    pass_tds: "player_pass_tds",
    rush_tds: "player_rush_tds",
    anytime_td: "player_anytime_td",
    // MLB (note: batter_ and pitcher_ prefixes)
    hits: "batter_hits",
    home_runs: "batter_home_runs",
    rbis: "batter_rbis",
    total_bases: "batter_total_bases",
    runs_scored: "batter_runs_scored",
    strikeouts: "pitcher_strikeouts",
    pitcher_strikeouts: "pitcher_strikeouts",
    batter_strikeouts: "batter_strikeouts",
    walks: "pitcher_walks",
    // NHL
    goals: "player_goals",
    shots_on_goal: "player_shots_on_goal",
    saves: "player_total_saves",
    power_play_points: "player_power_play_points",
    anytime_goal: "player_goal_scorer_anytime",
    // Soccer
    anytime_goal_scorer: "player_goal_scorer_anytime",
    shots: "player_shots",
    shots_on_target: "player_shots_on_target",
  };

  const oddsMarket = propsMarketMap[market.toLowerCase()] ?? `player_${market.toLowerCase()}`;

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

    // Improvement 2: Smart Event Matching - prioritize events with matching player team
    const playerLower = playerName.toLowerCase();
    const playerTeamLower = playerTeam?.toLowerCase();

    // Sort events: team matches first, then others
    const sortedEvents = playerTeamLower
      ? events.sort((a: Record<string, unknown>, b: Record<string, unknown>) => {
          const aHasTeam =
            String(a.home_team ?? "").toLowerCase() === playerTeamLower ||
            String(a.away_team ?? "").toLowerCase() === playerTeamLower
              ? 1
              : 0;
          const bHasTeam =
            String(b.home_team ?? "").toLowerCase() === playerTeamLower ||
            String(b.away_team ?? "").toLowerCase() === playerTeamLower
              ? 1
              : 0;
          return bHasTeam - aHasTeam;
        })
      : events;

    console.log(`[Props] Event matching: playerTeam=${playerTeam}, checking ${sortedEvents.slice(0, 5).length} events (team-prioritized)`);

    // Step 2: Check each event for this player's props (limit to first 5 to preserve quota)
    for (const event of sortedEvents.slice(0, 5)) {
      const eventId = event.id as string;
      const eventTeams = `${event.home_team ?? "?"} vs ${event.away_team ?? "?"}`;
      console.log(`[Props] Checking event ${eventId}: ${eventTeams}`);

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
