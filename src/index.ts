#!/usr/bin/env node
/**
 * Betting Intelligence MCP Server
 *
 * A production-ready remote MCP server that exposes:
 *   1. Unified Search Tools — Brave, Perplexity, Tavily
 *   2. Sports Betting Intelligence — odds, value, props, parlays, arb, Kelly, sharp, weather, injury, situational
 *   3. Self-Improving Learning Layer — bet logging, CLV, performance, edge identification, confidence scoring
 *
 * Runs on Railway as HTTP transport (Streamable HTTP).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";

// ── Tool implementations ─────────────────────────────────────────────────────
import { braveSearch } from "./tools/search/brave.js";
import { perplexitySearch } from "./tools/search/perplexity.js";
import { tavilySearch, tavilyExtract } from "./tools/search/tavily.js";
import { getLiveOdds } from "./tools/betting/odds.js";
import { findValueLines } from "./tools/betting/value.js";
import { getOddsJamPositiveEV } from "./tools/betting/oddsjam.js";
import { buildPlayerProp } from "./tools/betting/props.js";
import { buildParlay } from "./tools/betting/parlay.js";
import { detectArbitrage } from "./tools/betting/arb.js";
import { calculateKelly } from "./tools/betting/kelly.js";
import { getSharpAction } from "./tools/betting/sharp.js";
import { getWeather } from "./tools/betting/weather.js";
import { getInjuryReport } from "./tools/betting/injury.js";
import { getSituationalAngles } from "./tools/betting/situational.js";
import { logBet } from "./tools/learning/logger.js";
import { recordCLV, recordResult } from "./tools/learning/clv.js";
import { analyzePerformance } from "./tools/learning/performance.js";
import { identifyEdges } from "./tools/learning/edges.js";
import { getConfidenceScore } from "./tools/learning/confidence.js";
import { shopLines } from "./tools/betting/shop.js";
import { getFutures } from "./tools/betting/futures.js";
import { getLiveInPlayOdds } from "./tools/betting/live.js";
import { getPowerRatings } from "./tools/betting/ratings.js";
import { queryLineHistory } from "./tools/betting/history.js";
import { manageBankroll } from "./tools/learning/bankroll.js";
import { manageAlerts } from "./tools/betting/alerts.js";
import { getConsensusPicks } from "./tools/betting/consensus.js";
import { truncateIfNeeded } from "./utils/helpers.js";
import { initializeSchema, seedSituationalAngles } from "./db/client.js";

// ═════════════════════════════════════════════════════════════════════════════
// Server Setup
// ═════════════════════════════════════════════════════════════════════════════

const server = new McpServer({
  name: process.env.MCP_SERVER_NAME ?? "betting-intelligence",
  version: "1.0.0",
});

// ═════════════════════════════════════════════════════════════════════════════
// TOOL 1: Unified Search
// ═════════════════════════════════════════════════════════════════════════════

server.registerTool(
  "unified_search",
  {
    title: "Unified Web Search",
    description: `Search the web using Brave, Perplexity, and/or Tavily. Three modes:
- "fast": Brave Search — returns top 10 results with titles, URLs, snippets
- "deep": Perplexity Sonar Pro — returns a synthesized AI answer with citations
- "crawl": Tavily Extract — extracts full clean content from a specific URL (pass the URL as the query)
If mode is not specified, calls all three in parallel and merges results.

Args:
  - query (string): Search query or URL (for crawl mode)
  - mode (optional): "fast" | "deep" | "crawl" — if omitted, runs all three
  - recency (optional): "day" | "week" | "any" — filter by freshness

Returns: JSON with results from each search provider.`,
    inputSchema: {
      query: z.string().min(1).describe("Search query or URL for crawl mode"),
      mode: z
        .enum(["fast", "deep", "crawl"])
        .optional()
        .describe('Search mode: "fast" (Brave), "deep" (Perplexity), "crawl" (Tavily extract)'),
      recency: z
        .enum(["day", "week", "any"])
        .optional()
        .describe("Freshness filter"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const results: Record<string, unknown> = {};

      if (params.mode === "fast" || !params.mode) {
        try {
          results.brave = await braveSearch(params.query, {
            recency: params.recency,
          });
        } catch (e) {
          results.brave_error = e instanceof Error ? e.message : String(e);
        }
      }

      if (params.mode === "deep" || !params.mode) {
        try {
          results.perplexity = await perplexitySearch(params.query);
        } catch (e) {
          results.perplexity_error =
            e instanceof Error ? e.message : String(e);
        }
      }

      if (params.mode === "crawl") {
        try {
          results.tavily_extract = await tavilyExtract(params.query);
        } catch (e) {
          results.tavily_error = e instanceof Error ? e.message : String(e);
        }
      } else if (!params.mode) {
        try {
          results.tavily = await tavilySearch(params.query, {
            recency: params.recency,
          });
        } catch (e) {
          results.tavily_error = e instanceof Error ? e.message : String(e);
        }
      }

      const text = truncateIfNeeded(JSON.stringify(results, null, 2));
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Search error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// ═════════════════════════════════════════════════════════════════════════════
// TOOL 2: Live Odds
// ═════════════════════════════════════════════════════════════════════════════

server.registerTool(
  "get_live_odds",
  {
    title: "Get Live Odds",
    description: `Fetch live odds across all bookmakers for a sport/game/market.
Returns all available lines sorted best-to-worst for each side, plus Pinnacle's sharp reference line.
Cached for 60 seconds to preserve API quota.

Args:
  - sport (string): nfl, nba, mlb, nhl, ncaaf, ncaab
  - game (optional string): Team name filter (e.g. "Chiefs", "Lakers")
  - market (optional string): h2h (default), spreads, totals, props

Returns: Array of games with bookmaker odds, Pinnacle reference, and best lines.`,
    inputSchema: {
      sport: z.string().min(1).describe("Sport: nfl, nba, mlb, nhl, ncaaf, ncaab"),
      game: z.string().optional().describe("Team name filter"),
      market: z
        .string()
        .optional()
        .describe("Market: h2h (default), spreads, totals"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const odds = await getLiveOdds(params);
      const text = truncateIfNeeded(JSON.stringify(odds, null, 2));
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  }
);

// ═════════════════════════════════════════════════════════════════════════════
// TOOL 3: Find Value Lines
// ═════════════════════════════════════════════════════════════════════════════

server.registerTool(
  "find_value_line",
  {
    title: "Find Value Lines",
    description: `Compare every book's line against Pinnacle's closing line.
Flags any line where implied probability differential exceeds 2% as a value opportunity.

Args:
  - sport (string): nfl, nba, mlb, nhl, ncaaf, ncaab
  - game (optional string): Team name filter
  - bet_type (optional string): Market — h2h, spreads, totals
  - side (optional string): Filter to a specific side

Returns: Value lines with rating (1-10), best book, EV%, Pinnacle reference.`,
    inputSchema: {
      sport: z.string().min(1).describe("Sport"),
      game: z.string().optional().describe("Team name filter"),
      bet_type: z.string().optional().describe("Market: h2h, spreads, totals"),
      side: z.string().optional().describe("Side filter"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const result = await findValueLines(params);
      return {
        content: [{ type: "text", text: truncateIfNeeded(JSON.stringify(result, null, 2)) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          { type: "text", text: error instanceof Error ? error.message : String(error) },
        ],
      };
    }
  }
);

// ═════════════════════════════════════════════════════════════════════════════
// TOOL 4: Player Props Builder
// ═════════════════════════════════════════════════════════════════════════════

server.registerTool(
  "build_player_prop",
  {
    title: "Build Player Prop",
    description: `Build a player prop card with stats, projections, and recommendation.
Fetches SportsRadar player stats, The Odds API prop lines, and calculates matchup-adjusted projections.

Args:
  - player_name (string): Full player name (e.g. "Patrick Mahomes")
  - market (string): Stat market — points, rebounds, assists, passing_yards, rushing_yards, strikeouts, etc.
  - sport (string): nfl, nba, mlb, nhl

Returns: Full prop card with over/under recommendation, confidence score, hit rate, supporting data.`,
    inputSchema: {
      player_name: z.string().min(1).describe("Player name"),
      market: z.string().min(1).describe("Stat market: points, rebounds, assists, passing_yards, etc."),
      sport: z.string().min(1).describe("Sport"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const result = await buildPlayerProp(params);
      return {
        content: [{ type: "text", text: truncateIfNeeded(JSON.stringify(result, null, 2)) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          { type: "text", text: error instanceof Error ? error.message : String(error) },
        ],
      };
    }
  }
);

// ═════════════════════════════════════════════════════════════════════════════
// TOOL 5: Parlay Builder
// ═════════════════════════════════════════════════════════════════════════════

server.registerTool(
  "build_parlay",
  {
    title: "Build Parlay",
    description: `Build a multi-leg parlay with correlation checking and EV analysis.
Checks correlations between all leg pairs, calculates true combined probability vs book odds,
and provides an EV assessment.

Args:
  - legs (array): Array of parlay legs, each with: game, side, book, odds (American), type (h2h/spread/total/prop)
  - books (optional string[]): Preferred sportsbooks

Returns: Combined odds, true probability, juice %, EV %, correlation warnings, recommendation.`,
    inputSchema: {
      legs: z
        .array(
          z.object({
            game: z.string().describe("Game description"),
            side: z.string().describe("Bet side"),
            book: z.string().describe("Sportsbook"),
            odds: z.number().describe("American odds"),
            point: z.number().optional().describe("Spread/total number"),
            type: z.string().describe("h2h, spread, total, or prop"),
          })
        )
        .min(2)
        .describe("Parlay legs"),
      books: z.array(z.string()).optional().describe("Preferred books"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params) => {
    try {
      const result = buildParlay(params);
      return {
        content: [{ type: "text", text: truncateIfNeeded(JSON.stringify(result, null, 2)) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          { type: "text", text: error instanceof Error ? error.message : String(error) },
        ],
      };
    }
  }
);

// ═════════════════════════════════════════════════════════════════════════════
// TOOL 6: Arbitrage Detector
// ═════════════════════════════════════════════════════════════════════════════

server.registerTool(
  "detect_arbitrage",
  {
    title: "Detect Arbitrage & Middles",
    description: `Scan all markets across all books for arbitrage (guaranteed profit) and middles (both sides can win).

Args:
  - sport (string): nfl, nba, mlb, nhl, ncaaf, ncaab
  - game (optional string): Team name filter — scans all games if omitted
  - stake (optional number): Total stake for bet sizing (default $1000)

Returns: Any arb/middle opportunities with profit %, exact bet amounts.`,
    inputSchema: {
      sport: z.string().min(1).describe("Sport"),
      game: z.string().optional().describe("Team filter"),
      stake: z.number().optional().describe("Total stake (default 1000)"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const result = await detectArbitrage(params);
      return {
        content: [{ type: "text", text: truncateIfNeeded(JSON.stringify(result, null, 2)) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          { type: "text", text: error instanceof Error ? error.message : String(error) },
        ],
      };
    }
  }
);

// ═════════════════════════════════════════════════════════════════════════════
// TOOL 6b: OddsJam Positive EV
// ═════════════════════════════════════════════════════════════════════════════

server.registerTool(
  "get_positive_ev",
  {
    title: "Get Positive EV Bets (OddsJam)",
    description: `Fetch pre-computed positive expected value bets from OddsJam.
OddsJam compares soft book lines against sharp books (Pinnacle) and flags +EV opportunities.
Requires ODDSJAM_API_KEY (paid, starts at $99/month).

Args:
  - sport (optional string): Filter by sport
  - min_ev (optional number): Minimum EV% threshold (e.g. 2.0 for 2%+)
  - sportsbook (optional string): Filter to a specific book

Returns: List of +EV bets with fair odds, book odds, and EV percentage.`,
    inputSchema: {
      sport: z.string().optional().describe("Sport filter"),
      min_ev: z.number().optional().describe("Minimum EV% (e.g. 2.0)"),
      sportsbook: z.string().optional().describe("Sportsbook filter"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const result = await getOddsJamPositiveEV(params);
      return {
        content: [{ type: "text", text: truncateIfNeeded(JSON.stringify(result, null, 2)) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          { type: "text", text: error instanceof Error ? error.message : String(error) },
        ],
      };
    }
  }
);

// ═════════════════════════════════════════════════════════════════════════════
// TOOL 7: Kelly Bet Sizing
// ═════════════════════════════════════════════════════════════════════════════

server.registerTool(
  "kelly_bet_size",
  {
    title: "Kelly Criterion Bet Sizing",
    description: `Calculate optimal bet size using the Kelly Criterion.

Args:
  - bankroll (number): Your total bankroll in dollars
  - edge_percentage (number): Estimated edge in percent (e.g. 3.5 for 3.5%)
  - odds (number): American odds (e.g. -110, +150)
  - kelly_fraction (optional number): Fraction of Kelly to use (default 0.25 = quarter Kelly)

Returns: Recommended bet in dollars, % of bankroll, risk assessment.`,
    inputSchema: {
      bankroll: z.number().positive().describe("Total bankroll in dollars"),
      edge_percentage: z.number().describe("Estimated edge in %"),
      odds: z.number().describe("American odds"),
      kelly_fraction: z
        .number()
        .min(0.01)
        .max(1)
        .optional()
        .describe("Kelly fraction (default 0.25)"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params) => {
    try {
      const result = calculateKelly(params);
      return {
        content: [{ type: "text", text: truncateIfNeeded(JSON.stringify(result, null, 2)) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          { type: "text", text: error instanceof Error ? error.message : String(error) },
        ],
      };
    }
  }
);

// ═════════════════════════════════════════════════════════════════════════════
// TOOL 8: Sharp Money
// ═════════════════════════════════════════════════════════════════════════════

server.registerTool(
  "get_sharp_action",
  {
    title: "Get Sharp Money Action",
    description: `Track sharp money, public betting percentages, and reverse line movement.
Identifies steam moves (multiple books moving simultaneously) and RLM (strong sharp signal).

Args:
  - sport (string): nfl, nba, mlb, nhl, ncaaf, ncaab
  - game (optional string): Team name filter

Returns: Sharp side, public side, line movement summary, steam move alerts.`,
    inputSchema: {
      sport: z.string().min(1).describe("Sport"),
      game: z.string().optional().describe("Team filter"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const result = await getSharpAction(params);
      return {
        content: [{ type: "text", text: truncateIfNeeded(JSON.stringify(result, null, 2)) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          { type: "text", text: error instanceof Error ? error.message : String(error) },
        ],
      };
    }
  }
);

// ═════════════════════════════════════════════════════════════════════════════
// TOOL 9: Weather
// ═════════════════════════════════════════════════════════════════════════════

server.registerTool(
  "get_weather",
  {
    title: "Get Game Weather",
    description: `Fetch weather forecast for an outdoor stadium and assess betting impact.
Includes wind speed/direction (critical for passing/kicking), temperature, precipitation.

Args:
  - stadium_name (string): Stadium name (e.g. "Lambeau Field", "Arrowhead Stadium")
  - game_date (string): ISO date/time of the game

Returns: Weather data + betting impact assessment (e.g. "Wind 18mph — fade passing totals").`,
    inputSchema: {
      stadium_name: z.string().min(1).describe("Stadium name"),
      game_date: z.string().min(1).describe("Game date/time in ISO format"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const result = await getWeather(params);
      return {
        content: [{ type: "text", text: truncateIfNeeded(JSON.stringify(result, null, 2)) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          { type: "text", text: error instanceof Error ? error.message : String(error) },
        ],
      };
    }
  }
);

// ═════════════════════════════════════════════════════════════════════════════
// TOOL 10: Injury Report
// ═════════════════════════════════════════════════════════════════════════════

server.registerTool(
  "get_injury_report",
  {
    title: "Get Injury Report",
    description: `Fetch injury and lineup status for a sport/team.
Includes estimated line impact per player.

Args:
  - sport (string): nfl, nba, mlb, nhl
  - team (optional string): Team name filter
  - game_date (optional string): Date filter

Returns: Injury list with status, position, line impact estimates.`,
    inputSchema: {
      sport: z.string().min(1).describe("Sport"),
      team: z.string().optional().describe("Team filter"),
      game_date: z.string().optional().describe("Date filter"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const result = await getInjuryReport(params);
      return {
        content: [{ type: "text", text: truncateIfNeeded(JSON.stringify(result, null, 2)) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          { type: "text", text: error instanceof Error ? error.message : String(error) },
        ],
      };
    }
  }
);

// ═════════════════════════════════════════════════════════════════════════════
// TOOL 11: Situational Angles
// ═════════════════════════════════════════════════════════════════════════════

server.registerTool(
  "get_situational_angles",
  {
    title: "Get Situational Angles",
    description: `Check a game against a database of proven betting trends.
Includes NFL road dogs off bye, NBA back-to-backs, MLB bullpen overuse, NHL goalie fatigue, and more.

Args:
  - sport (string): nfl, nba, mlb, nhl
  - game (string): Game description (e.g. "Chiefs vs Bills")
  - conditions (optional object): Game conditions to match against (e.g. {home_away: "away", off_bye: true})

Returns: Matching angles with historical ROI, sample size, combined angle score.`,
    inputSchema: {
      sport: z.string().min(1).describe("Sport"),
      game: z.string().min(1).describe("Game description"),
      conditions: z
        .record(z.unknown())
        .optional()
        .describe("Conditions to check against the angle database"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params) => {
    try {
      const result = await getSituationalAngles(params);
      return {
        content: [{ type: "text", text: truncateIfNeeded(JSON.stringify(result, null, 2)) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          { type: "text", text: error instanceof Error ? error.message : String(error) },
        ],
      };
    }
  }
);

// ═════════════════════════════════════════════════════════════════════════════
// TOOL 12: Log Bet
// ═════════════════════════════════════════════════════════════════════════════

server.registerTool(
  "log_bet",
  {
    title: "Log a Bet",
    description: `Log a bet to the database with full context tags for future analysis.

Args:
  - sport, game, side, odds, stake, book (required)
  - bet_type, market, player_name, line, league, game_date (optional)
  - edge_pct, sharp_pct, public_pct, kelly_fraction, confidence_score (optional)
  - weather_summary, injury_flags, situational_angles (optional)

Returns: bet_id for future CLV tracking and result recording.`,
    inputSchema: {
      sport: z.string().min(1),
      game: z.string().min(1),
      side: z.string().min(1),
      odds: z.number(),
      stake: z.number().positive(),
      book: z.string().min(1),
      bet_type: z.string().optional(),
      market: z.string().optional(),
      player_name: z.string().optional(),
      line: z.number().optional(),
      league: z.string().optional(),
      game_date: z.string().optional(),
      edge_pct: z.number().optional(),
      sharp_pct: z.number().optional(),
      public_pct: z.number().optional(),
      kelly_fraction: z.number().optional(),
      confidence_score: z.number().optional(),
      weather_summary: z.string().optional(),
      injury_flags: z.array(z.unknown()).optional(),
      situational_angles: z.array(z.unknown()).optional(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async (params) => {
    try {
      const result = await logBet({
        ...params,
        bet_type: params.bet_type ?? "unknown",
      });
      return {
        content: [{ type: "text", text: truncateIfNeeded(JSON.stringify(result, null, 2)) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          { type: "text", text: error instanceof Error ? error.message : String(error) },
        ],
      };
    }
  }
);

// ═════════════════════════════════════════════════════════════════════════════
// TOOL 13: Record CLV
// ═════════════════════════════════════════════════════════════════════════════

server.registerTool(
  "record_clv",
  {
    title: "Record Closing Line Value",
    description: `Record the closing line for a bet and calculate CLV.
CLV is the primary performance metric — weighted more heavily than win/loss.

Args:
  - bet_id (number): ID from log_bet
  - closing_line (number): American odds at close

Returns: CLV calculation with interpretation.`,
    inputSchema: {
      bet_id: z.number().int().positive(),
      closing_line: z.number(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params) => {
    try {
      const result = await recordCLV(params);
      return {
        content: [{ type: "text", text: truncateIfNeeded(JSON.stringify(result, null, 2)) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          { type: "text", text: error instanceof Error ? error.message : String(error) },
        ],
      };
    }
  }
);

// ═════════════════════════════════════════════════════════════════════════════
// TOOL 14: Record Result
// ═════════════════════════════════════════════════════════════════════════════

server.registerTool(
  "record_result",
  {
    title: "Record Bet Result",
    description: `Record the outcome and payout for a logged bet.

Args:
  - bet_id (number): ID from log_bet
  - outcome (string): "win", "loss", "push", or "void"
  - actual_payout (number): Actual payout in dollars

Returns: Confirmation.`,
    inputSchema: {
      bet_id: z.number().int().positive(),
      outcome: z.enum(["win", "loss", "push", "void"]),
      actual_payout: z.number(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params) => {
    try {
      const result = await recordResult(params);
      return {
        content: [{ type: "text", text: truncateIfNeeded(JSON.stringify(result, null, 2)) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          { type: "text", text: error instanceof Error ? error.message : String(error) },
        ],
      };
    }
  }
);

// ═════════════════════════════════════════════════════════════════════════════
// TOOL 15: Performance Analysis
// ═════════════════════════════════════════════════════════════════════════════

server.registerTool(
  "analyze_performance",
  {
    title: "Analyze Betting Performance",
    description: `Analyze your betting history for ROI, CLV, and patterns.
Breaks down by sport, bet type, book, and identifies best/worst conditions.

Args:
  - sport (optional): Filter by sport
  - bet_type (optional): Filter by bet type
  - date_from (optional): Start date
  - date_to (optional): End date
  - min_bets (optional): Minimum bets for condition clusters (default 1)

Returns: Full performance report with actionable insights.`,
    inputSchema: {
      sport: z.string().optional(),
      bet_type: z.string().optional(),
      date_from: z.string().optional(),
      date_to: z.string().optional(),
      min_bets: z.number().int().optional(),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params) => {
    try {
      const result = await analyzePerformance(params);
      return {
        content: [{ type: "text", text: truncateIfNeeded(JSON.stringify(result, null, 2)) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          { type: "text", text: error instanceof Error ? error.message : String(error) },
        ],
      };
    }
  }
);

// ═════════════════════════════════════════════════════════════════════════════
// TOOL 16: Identify Edges
// ═════════════════════════════════════════════════════════════════════════════

server.registerTool(
  "identify_edges",
  {
    title: "Identify Betting Edges",
    description: `Scan your full bet history to find the most profitable condition combinations.
Clusters bets by sport/type/book and ranks by ROI with minimum sample size.

Args:
  - min_sample_size (optional number): Minimum bets per cluster (default 20)

Returns: Top 5 edge clusters with ROI, CLV, insight for each.`,
    inputSchema: {
      min_sample_size: z.number().int().optional().describe("Min bets per cluster (default 20)"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params) => {
    try {
      const result = await identifyEdges(params);
      return {
        content: [{ type: "text", text: truncateIfNeeded(JSON.stringify(result, null, 2)) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          { type: "text", text: error instanceof Error ? error.message : String(error) },
        ],
      };
    }
  }
);

// ═════════════════════════════════════════════════════════════════════════════
// TOOL 17: Confidence Score
// ═════════════════════════════════════════════════════════════════════════════

server.registerTool(
  "get_confidence_score",
  {
    title: "Get Confidence Score",
    description: `Score a proposed bet 1-10 based on confirming signals.
Higher score = more signals aligned (sharp money + line movement + statistical edge + situational angles + weather).

Args:
  - sport, game, side, bet_type, odds (required)
  - edge_pct, sharp_pct, line_movement_favorable, reverse_line_movement, steam_move (optional)
  - situational_angles_matched, weather_impact, injury_advantage (optional)
  - data_completeness (0-100), historical_roi_for_type (optional)

Returns: Score 1-10, grade A+ through F, breakdown of each signal's contribution, recommendation.`,
    inputSchema: {
      sport: z.string().min(1),
      game: z.string().min(1),
      side: z.string().min(1),
      bet_type: z.string().min(1),
      odds: z.number(),
      edge_pct: z.number().optional(),
      sharp_pct: z.number().optional(),
      line_movement_favorable: z.boolean().optional(),
      reverse_line_movement: z.boolean().optional(),
      steam_move: z.boolean().optional(),
      situational_angles_matched: z.number().optional(),
      weather_impact: z.enum(["none", "favorable", "unfavorable"]).optional(),
      injury_advantage: z.boolean().optional(),
      data_completeness: z.number().min(0).max(100).optional(),
      historical_roi_for_type: z.number().optional(),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params) => {
    try {
      const result = getConfidenceScore(params);
      return {
        content: [{ type: "text", text: truncateIfNeeded(JSON.stringify(result, null, 2)) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          { type: "text", text: error instanceof Error ? error.message : String(error) },
        ],
      };
    }
  }
);

// ═════════════════════════════════════════════════════════════════════════════
// TOOL 18: Shop Lines
// ═════════════════════════════════════════════════════════════════════════════

server.registerTool(
  "shop_lines",
  {
    title: "Shop Lines Across Books",
    description: `Find the best price for a specific bet across all sportsbooks.
Returns a sorted table of every book's price with edge vs Pinnacle for each.

Args:
  - sport (string): nfl, nba, mlb, nhl, ncaaf, ncaab
  - game (string): Team name to find the game (e.g. "Chiefs", "Lakers vs Celtics")
  - side (string): The side you want to bet (e.g. "Chiefs", "Over", "Lakers")
  - market (optional string): h2h (default), spreads, totals

Returns: Ranked list of every book's price, EV vs Pinnacle, best/worst book, recommendation.`,
    inputSchema: {
      sport: z.string().min(1).describe("Sport"),
      game: z.string().min(1).describe("Team name to find the game"),
      side: z.string().min(1).describe("Side to bet"),
      market: z.string().optional().describe("Market: h2h, spreads, totals"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const result = await shopLines(params);
      return {
        content: [{ type: "text", text: truncateIfNeeded(JSON.stringify(result, null, 2)) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          { type: "text", text: error instanceof Error ? error.message : String(error) },
        ],
      };
    }
  }
);

// ═════════════════════════════════════════════════════════════════════════════
// TOOL 19: Futures & Outrights
// ═════════════════════════════════════════════════════════════════════════════

server.registerTool(
  "get_futures",
  {
    title: "Get Futures & Outrights",
    description: `Fetch championship, conference, and division winner futures odds.
High-edge markets where books are lazier about pricing.

Args:
  - sport (string): nfl, nba, mlb, nhl, ncaaf, ncaab
  - market_type (optional string): "championship", "conference", "division"
  - team (optional string): Filter to a specific team

Returns: Futures odds from all books, best odds per team.`,
    inputSchema: {
      sport: z.string().min(1).describe("Sport"),
      market_type: z.string().optional().describe('Filter: "championship", "conference", "division"'),
      team: z.string().optional().describe("Team name filter"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const result = await getFutures(params);
      const text = truncateIfNeeded(JSON.stringify(result, null, 2));
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        isError: true,
        content: [
          { type: "text", text: error instanceof Error ? error.message : String(error) },
        ],
      };
    }
  }
);

// ═════════════════════════════════════════════════════════════════════════════
// TOOL 20: Live / In-Play Odds
// ═════════════════════════════════════════════════════════════════════════════

server.registerTool(
  "get_live_in_play",
  {
    title: "Get Live In-Play Odds",
    description: `Fetch odds for games currently in progress.
Filters to live events only and flags value where books are slow to adjust.
Live markets have the biggest mispricings.

Args:
  - sport (string): nfl, nba, mlb, nhl, ncaaf, ncaab
  - game (optional string): Team name filter
  - market (optional string): h2h (default), spreads, totals

Returns: Live games with odds, value alerts where books are slow.`,
    inputSchema: {
      sport: z.string().min(1).describe("Sport"),
      game: z.string().optional().describe("Team filter"),
      market: z.string().optional().describe("Market: h2h, spreads, totals"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const result = await getLiveInPlayOdds(params);
      const text = truncateIfNeeded(JSON.stringify(result, null, 2));
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        isError: true,
        content: [
          { type: "text", text: error instanceof Error ? error.message : String(error) },
        ],
      };
    }
  }
);

// ═════════════════════════════════════════════════════════════════════════════
// TOOL 21: Power Ratings / Elo
// ═════════════════════════════════════════════════════════════════════════════

server.registerTool(
  "power_ratings",
  {
    title: "Power Ratings & Elo Model",
    description: `Independent Elo power rating system for fair line estimation.
Provides a second opinion alongside Pinnacle to compare against market odds.

Three modes:
- "ratings": View all team ratings for a sport (sorted by Elo)
- "matchup": Predict a game with fair line and win probabilities
- "record_result": Update ratings with a game result

Args:
  - sport (string): nfl, nba, mlb, nhl
  - action (optional): "ratings" | "matchup" | "record_result"
  - home_team (optional): For matchup prediction
  - away_team (optional): For matchup prediction
  - winner / loser (optional): For recording results
  - home_score / away_score (optional): For margin-weighted updates

Returns: Team ratings, matchup prediction with fair ML odds, or updated Elo.`,
    inputSchema: {
      sport: z.string().min(1).describe("Sport"),
      action: z.enum(["ratings", "matchup", "record_result"]).optional().describe("Mode"),
      home_team: z.string().optional().describe("Home team for matchup"),
      away_team: z.string().optional().describe("Away team for matchup"),
      winner: z.string().optional().describe("Winning team (record_result)"),
      loser: z.string().optional().describe("Losing team (record_result)"),
      home_score: z.number().optional().describe("Home score"),
      away_score: z.number().optional().describe("Away score"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async (params) => {
    try {
      const result = await getPowerRatings(params);
      return {
        content: [{ type: "text", text: truncateIfNeeded(JSON.stringify(result, null, 2)) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          { type: "text", text: error instanceof Error ? error.message : String(error) },
        ],
      };
    }
  }
);

// ═════════════════════════════════════════════════════════════════════════════
// TOOL 22: Historical Line Query
// ═════════════════════════════════════════════════════════════════════════════

server.registerTool(
  "query_line_history",
  {
    title: "Query Line Movement History",
    description: `View how lines moved from open to close with timestamps.
Detects steam moves (3+ books moving same direction) and RLM patterns.
Data comes from automatic line snapshots taken each time get_live_odds is called.

Args:
  - game_id (optional string): Specific game ID from get_live_odds
  - sport (optional string): Sport filter
  - side (optional string): Side filter (e.g. "Chiefs", "Over")
  - market (optional string): h2h, spreads, totals
  - hours_back (optional number): How far back to look (default 48)

Returns: Line movement per book, steam move detection, sharp indicators, summary.`,
    inputSchema: {
      game_id: z.string().optional().describe("Game ID"),
      sport: z.string().optional().describe("Sport filter"),
      side: z.string().optional().describe("Side filter"),
      market: z.string().optional().describe("Market"),
      hours_back: z.number().optional().describe("Hours to look back (default 48)"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params) => {
    try {
      const result = await queryLineHistory(params);
      const text = truncateIfNeeded(JSON.stringify(result, null, 2));
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        isError: true,
        content: [
          { type: "text", text: error instanceof Error ? error.message : String(error) },
        ],
      };
    }
  }
);

// ═════════════════════════════════════════════════════════════════════════════
// TOOL 23: Bankroll Tracker
// ═════════════════════════════════════════════════════════════════════════════

server.registerTool(
  "bankroll",
  {
    title: "Bankroll Tracker",
    description: `Track your bankroll balance, drawdown, and Kelly compliance.

Four modes:
- "status": Full bankroll report (balance, drawdown, ROI, period stats, Kelly compliance)
- "set_balance": Set your starting bankroll (e.g. $5000)
- "deposit": Add funds
- "withdraw": Remove funds

Args:
  - action (optional): "status" (default) | "set_balance" | "deposit" | "withdraw"
  - amount (optional): Dollar amount for deposit/withdraw/set_balance
  - note (optional): Description of the transaction

Returns: Full bankroll status with drawdown %, period P&L, Kelly compliance rating.`,
    inputSchema: {
      action: z.enum(["status", "set_balance", "deposit", "withdraw"]).optional().describe("Mode"),
      amount: z.number().optional().describe("Dollar amount"),
      note: z.string().optional().describe("Transaction note"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async (params) => {
    try {
      const result = await manageBankroll(params);
      return {
        content: [{ type: "text", text: truncateIfNeeded(JSON.stringify(result, null, 2)) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          { type: "text", text: error instanceof Error ? error.message : String(error) },
        ],
      };
    }
  }
);

// ═════════════════════════════════════════════════════════════════════════════
// TOOL 24: Webhook Alerts
// ═════════════════════════════════════════════════════════════════════════════

server.registerTool(
  "manage_alerts",
  {
    title: "Manage Webhook Alerts",
    description: `Configure alerts that fire webhooks (Discord, Slack, or generic) when conditions are met.
Arb windows close fast — passive monitoring matters.

Five modes:
- "create": Create a new alert with threshold
- "list": View all configured alerts
- "delete": Remove an alert by ID
- "check": Scan current odds against all active alerts
- "test": Send a test message to verify webhook

Args:
  - action (string): "create" | "list" | "delete" | "check" | "test"
  - name (optional): Alert name (for create)
  - sport (optional): Sport filter
  - alert_type (optional): "value" | "arb" | "steam" | "odds_change"
  - threshold (optional): Minimum % to trigger (e.g. 5 for 5% EV)
  - webhook_url (optional): Discord/Slack/generic webhook URL
  - webhook_type (optional): "discord" | "slack" | "generic" (auto-detected from URL)
  - alert_id (optional): For delete

Returns: Created alert, alert list, triggered results, or test confirmation.`,
    inputSchema: {
      action: z.enum(["create", "list", "delete", "check", "test"]).describe("Mode"),
      name: z.string().optional().describe("Alert name"),
      sport: z.string().optional().describe("Sport"),
      alert_type: z.enum(["value", "arb", "steam", "odds_change"]).optional().describe("Alert type"),
      threshold: z.number().optional().describe("Trigger threshold %"),
      webhook_url: z.string().optional().describe("Webhook URL"),
      webhook_type: z.enum(["discord", "slack", "generic"]).optional().describe("Webhook platform"),
      alert_id: z.number().optional().describe("Alert ID (for delete)"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const result = await manageAlerts(params);
      return {
        content: [{ type: "text", text: truncateIfNeeded(JSON.stringify(result, null, 2)) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          { type: "text", text: error instanceof Error ? error.message : String(error) },
        ],
      };
    }
  }
);

// ═════════════════════════════════════════════════════════════════════════════
// TOOL 25: Consensus Picks
// ═════════════════════════════════════════════════════════════════════════════

server.registerTool(
  "get_consensus",
  {
    title: "Get Consensus Picks & Public Betting",
    description: `Get public betting percentages and identify fade-the-public opportunities.
Tries ActionNetwork API for real bet/money percentages, falls back to analyzing
sharp vs public book line divergence to estimate public lean.

Args:
  - sport (string): nfl, nba, mlb, nhl, ncaaf, ncaab
  - game (optional string): Team name filter
  - market (optional string): h2h (default), spreads, totals

Returns: Public bet %, money %, sharp vs public divergence, fade opportunities.`,
    inputSchema: {
      sport: z.string().min(1).describe("Sport"),
      game: z.string().optional().describe("Team filter"),
      market: z.string().optional().describe("Market"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const result = await getConsensusPicks(params);
      const text = truncateIfNeeded(JSON.stringify(result, null, 2));
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        isError: true,
        content: [
          { type: "text", text: error instanceof Error ? error.message : String(error) },
        ],
      };
    }
  }
);

// ═════════════════════════════════════════════════════════════════════════════
// HTTP Server + MCP Transport
// ═════════════════════════════════════════════════════════════════════════════

async function startServer(): Promise<void> {
  // Initialize DB schema if DATABASE_URL is set
  await initializeSchema();
  await seedSituationalAngles();

  const app = express();
  app.use(express.json());

  // ── Rate Limiting (in-memory, per-IP, 60 req/min) ──────────────────────
  const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
  const RATE_LIMIT_WINDOW_MS = 60_000;
  const RATE_LIMIT_MAX = 60;

  app.use("/mcp", (req, res, next) => {
    const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    let entry = rateLimitMap.get(ip);

    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
      rateLimitMap.set(ip, entry);
    }

    entry.count++;
    res.setHeader("X-RateLimit-Limit", RATE_LIMIT_MAX);
    res.setHeader("X-RateLimit-Remaining", Math.max(0, RATE_LIMIT_MAX - entry.count));

    if (entry.count > RATE_LIMIT_MAX) {
      res.status(429).json({
        error: "Rate limit exceeded. Max 60 requests per minute.",
        retry_after_seconds: Math.ceil((entry.resetAt - now) / 1000),
      });
      return;
    }

    next();
  });

  // ── Optional Bearer Token Auth ─────────────────────────────────────────
  // Set MCP_AUTH_TOKEN env var to require authentication on /mcp.
  // If not set, the endpoint is open (useful for development).
  const authToken = process.env.MCP_AUTH_TOKEN;
  if (authToken) {
    app.use("/mcp", (req, res, next) => {
      const header = req.headers.authorization;
      if (!header || header !== `Bearer ${authToken}`) {
        res.status(401).json({
          error: "Unauthorized. Provide a valid Bearer token in the Authorization header.",
        });
        return;
      }
      next();
    });
    console.error("[Auth] Bearer token authentication enabled on /mcp");
  } else {
    console.error("[Auth] No MCP_AUTH_TOKEN set — /mcp endpoint is open");
  }

  // Periodic cleanup of rate limit map (every 5 minutes)
  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of rateLimitMap) {
      if (now > entry.resetAt) rateLimitMap.delete(ip);
    }
  }, 300_000);

  // Health check endpoint
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      server: process.env.MCP_SERVER_NAME ?? "betting-intelligence",
      version: "1.0.0",
      timestamp: new Date().toISOString(),
      tools: 26,
    });
  });

  // MCP endpoint — Streamable HTTP (stateless JSON mode)
  app.post("/mcp", async (req, res) => {
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      res.on("close", () => {
        transport.close();
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("[MCP] Request error:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  });

  // Handle DELETE for session cleanup (required by MCP spec)
  app.delete("/mcp", (_req, res) => {
    res.status(200).json({ message: "Session ended" });
  });

  // Handle GET for SSE fallback (return method not allowed)
  app.get("/mcp", (_req, res) => {
    res.status(405).json({
      error: "Method not allowed. Use POST for MCP requests.",
    });
  });

  const port = parseInt(process.env.PORT ?? "3000");
  app.listen(port, "0.0.0.0", () => {
    console.error(`
╔══════════════════════════════════════════════════════════╗
║  Betting Intelligence MCP Server                         ║
║  Running on http://0.0.0.0:${port}/mcp                      ║
║  Health check: http://0.0.0.0:${port}/health                ║
║  Tools: 26 registered                                    ║
║  Transport: Streamable HTTP (stateless JSON)             ║
╚══════════════════════════════════════════════════════════╝
    `);
  });
}

startServer().catch((error) => {
  console.error("Fatal server error:", error);
  process.exit(1);
});
