/**
 * Background Services
 * - Line snapshots every 15 minutes (records odds to Postgres)
 * - Alert scanning every 5 minutes (fires webhooks)
 * - CLV auto-capture every 2 minutes (closing lines for logged bets)
 */

import { getLiveOdds, GameOdds } from "../tools/betting/odds.js";
import { manageAlerts } from "../tools/betting/alerts.js";
import { query, isDatabaseConfigured } from "../db/client.js";
import { americanToImpliedProb } from "../utils/helpers.js";

// ── State ────────────────────────────────────────────────────────────────────

let isRunning = false;
const intervals: NodeJS.Timeout[] = [];

// Core sports to snapshot (uses user-friendly aliases → resolveSportKey handles mapping)
const SNAPSHOT_SPORTS = ["nba", "mlb", "nhl", "ncaab"];

// ── Public API ───────────────────────────────────────────────────────────────

export function startBackgroundServices(): void {
  if (isRunning) {
    console.error("[Background] Already running — skipping");
    return;
  }
  isRunning = true;
  console.error("[Background] Starting background services...");

  // 1. Line snapshots every 15 minutes
  runLineSnapshots();
  intervals.push(setInterval(runLineSnapshots, 15 * 60 * 1000));

  // 2. Alert scanning every 5 minutes
  runAlertScan();
  intervals.push(setInterval(runAlertScan, 5 * 60 * 1000));

  // 3. Auto CLV capture every 2 minutes (DB required)
  if (isDatabaseConfigured()) {
    runClvCapture();
    intervals.push(setInterval(runClvCapture, 2 * 60 * 1000));
  } else {
    console.error("[Background] No DATABASE_URL — CLV auto-capture disabled");
  }

  // 4. Opening line capture every 30 minutes (DB required)
  if (isDatabaseConfigured()) {
    runOpeningLineCapture();
    intervals.push(setInterval(runOpeningLineCapture, 30 * 60 * 1000));
  }

  console.error("[Background] All services started");
}

export function stopBackgroundServices(): void {
  for (const id of intervals) clearInterval(id);
  intervals.length = 0;
  isRunning = false;
  console.error("[Background] All services stopped");
}

// ── Line Snapshots ───────────────────────────────────────────────────────────

let snapshotIndex = 0;

async function runLineSnapshots(): Promise<void> {
  try {
    // Rotate through one sport per cycle to conserve API quota
    const sport = SNAPSHOT_SPORTS[snapshotIndex % SNAPSHOT_SPORTS.length];
    snapshotIndex++;

    for (const market of ["h2h", "spreads", "totals"]) {
      try {
        await getLiveOdds({ sport, market });
        // getLiveOdds already calls recordLineHistory internally
        await sleep(2000); // respect rate limits
      } catch (err) {
        console.error(`[LineSnapshot] ${sport}/${market} failed:`, err);
      }
    }
    console.error(`[LineSnapshot] Completed snapshot for ${sport}`);
  } catch (error) {
    console.error("[LineSnapshot] Cycle error:", error);
  }
}

// ── Alert Scanning ───────────────────────────────────────────────────────────

async function runAlertScan(): Promise<void> {
  try {
    await manageAlerts({ action: "check" });
    console.error("[AlertScan] Check complete");
  } catch (error) {
    console.error("[AlertScan] Error:", error);
  }
}

// ── Auto CLV Capture ─────────────────────────────────────────────────────────

async function runClvCapture(): Promise<void> {
  try {
    if (!isDatabaseConfigured()) return;

    // Find bets where game starts within next 10 minutes and closing_line is null
    const rows = (await query(
      `SELECT id, sport, game, side, market, odds
       FROM bets
       WHERE game_date IS NOT NULL
         AND game_date <= NOW() + INTERVAL '10 minutes'
         AND game_date >= NOW() - INTERVAL '5 minutes'
         AND closing_line IS NULL
       LIMIT 50`
    )) as Record<string, unknown>[];

    if (!rows || rows.length === 0) return;

    console.error(`[CLVCapture] Found ${rows.length} bets needing closing lines`);

    for (const bet of rows) {
      try {
        const sport = String(bet.sport);
        const market = String(bet.market ?? "h2h");
        const betSide = String(bet.side ?? "");
        const betOdds = Number(bet.odds);

        // Fetch current odds
        const games: GameOdds[] = await getLiveOdds({ sport, market });

        // Find matching game by name
        const betGame = String(bet.game ?? "").toLowerCase();
        const match = games.find(
          (g) =>
            betGame.includes(g.home_team.toLowerCase()) ||
            betGame.includes(g.away_team.toLowerCase())
        );

        if (!match) continue;

        // Find Pinnacle's current line as closing line reference
        const pinnacle = match.pinnacle_line;
        if (!pinnacle) continue;

        // Find the outcome that matches our bet side
        const outcome = pinnacle.outcomes.find((o) =>
          betSide.toLowerCase().includes(o.name.toLowerCase())
        );
        if (!outcome) continue;

        const closingLine = outcome.price;

        // Compute CLV: (closing_implied - open_implied) * 100
        const openProb = americanToImpliedProb(betOdds);
        const closeProb = americanToImpliedProb(closingLine);
        const clv = closeProb.minus(openProb).times(100).toDecimalPlaces(3).toNumber();

        await query(
          `UPDATE bets SET closing_line = $1, clv = $2 WHERE id = $3`,
          [closingLine, clv, bet.id]
        );

        console.error(
          `[CLVCapture] Bet #${bet.id}: closing=${closingLine}, CLV=${clv.toFixed(2)}%`
        );
      } catch (err) {
        console.error(`[CLVCapture] Error on bet #${bet.id}:`, err);
      }
    }
  } catch (error) {
    console.error("[CLVCapture] Cycle error:", error);
  }
}

// ── Opening Line Capture ────────────────────────────────────────────────────

async function runOpeningLineCapture(): Promise<void> {
  try {
    if (!isDatabaseConfigured()) return;

    for (const sport of SNAPSHOT_SPORTS) {
      try {
        const games: GameOdds[] = await getLiveOdds({ sport });
        for (const game of games) {
          const gameId = (game as unknown as Record<string, unknown>).id as string;
          if (!gameId) continue;

          // Check if we already have opening lines for this game
          const existing = await query(
            `SELECT id FROM opening_lines WHERE game_id = $1 LIMIT 1`,
            [gameId]
          );
          if (existing && (existing as unknown[]).length > 0) continue;

          // Store Pinnacle opening line (most accurate benchmark)
          const pinnacle = game.pinnacle_line;
          if (pinnacle) {
            for (const outcome of pinnacle.outcomes) {
              await query(
                `INSERT INTO opening_lines (game_id, sport, game, book, market, side, odds, line, captured_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
                 ON CONFLICT (game_id, book, market, side) DO NOTHING`,
                [
                  gameId,
                  sport,
                  `${game.away_team} @ ${game.home_team}`,
                  "pinnacle",
                  "h2h",
                  outcome.name,
                  outcome.price,
                  outcome.point ?? null,
                ]
              );
            }
          }

          // Also store consensus opening (first available book)
          const firstBook = (game as unknown as Record<string, unknown>).bookmakers as Array<Record<string, unknown>> | undefined;
          if (firstBook?.[0]) {
            const bm = firstBook[0];
            const markets = bm.markets as Array<Record<string, unknown>> | undefined;
            const outcomes = markets?.[0]?.outcomes as Array<Record<string, unknown>> ?? [];
            for (const outcome of outcomes) {
              await query(
                `INSERT INTO opening_lines (game_id, sport, game, book, market, side, odds, line, captured_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
                 ON CONFLICT (game_id, book, market, side) DO NOTHING`,
                [
                  gameId,
                  sport,
                  `${game.away_team} @ ${game.home_team}`,
                  String(bm.key ?? "consensus"),
                  "h2h",
                  String(outcome.name),
                  Number(outcome.price ?? 0),
                  outcome.point ?? null,
                ]
              );
            }
          }
        }
        await sleep(2000);
      } catch (err) {
        console.error(`[OpeningLines] ${sport} failed:`, err);
      }
    }
    console.error("[OpeningLines] Capture complete");
  } catch (error) {
    console.error("[OpeningLines] Cycle error:", error);
  }
}

// ── Util ─────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
