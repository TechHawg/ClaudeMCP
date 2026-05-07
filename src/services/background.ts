/**
 * Background Services
 * - Line snapshots every 15 minutes (records odds to Postgres)
 * - Alert scanning every 5 minutes (fires webhooks)
 * - CLV auto-capture every 2 minutes (closing lines for logged bets)
 * - Auto-settle every 10 minutes (pulls final scores, settles bets)
 */

import { getLiveOdds, GameOdds } from "../tools/betting/odds.js";
import { manageAlerts } from "../tools/betting/alerts.js";
import { query, isDatabaseConfigured } from "../db/client.js";
import { americanToImpliedProb, noVigProb2Way } from "../utils/helpers.js";
import { runAutoSettle, runEnhancedClvCapture } from "./auto-settle.js";
import { runBackfill } from "./backfill/index.js";
import { runSteamScan } from "./steam_scanner.js";
import { runLiveDriftCapture } from "./live_drift.js";

// ── State ────────────────────────────────────────────────────────────────────

let isRunning = false;
const intervals: NodeJS.Timeout[] = [];

// Core sports to snapshot (uses user-friendly aliases → resolveSportKey handles mapping)
const SNAPSHOT_SPORTS = ["nba", "mlb", "nhl", "ncaab"];

/**
 * The Odds API publishes remaining-quota in response headers; getLiveOdds logs
 * it. We track the most recently seen value here so background services can
 * back off when running low.
 */
let lastKnownQuotaRemaining: number | null = null;
const QUOTA_FLOOR = parseInt(process.env.ODDS_API_QUOTA_FLOOR ?? "1500", 10);

export function reportOddsApiQuota(remaining: number): void {
  lastKnownQuotaRemaining = remaining;
}

function quotaSafe(): boolean {
  if (lastKnownQuotaRemaining == null) return true;
  if (lastKnownQuotaRemaining <= QUOTA_FLOOR) {
    console.error(
      `[Quota] OddsAPI remaining=${lastKnownQuotaRemaining} <= floor=${QUOTA_FLOOR} — skipping snapshot cycle.`
    );
    return false;
  }
  return true;
}

// ── Public API ───────────────────────────────────────────────────────────────

export function startBackgroundServices(): void {
  if (isRunning) {
    console.error("[Background] Already running — skipping");
    return;
  }
  isRunning = true;
  console.error("[Background] Starting background services...");

  // 1. Line snapshots every 10 minutes. Drift gate needs ≥2 snapshots/1h —
  //    10min cadence gives 6/hour, more than enough. 5min was burning quota
  //    (~26K/month at 4 sports × 3 markets — over the 20K Odds API tier).
  runLineSnapshots();
  intervals.push(setInterval(runLineSnapshots, 10 * 60 * 1000));

  // 2. Alert scanning every 5 minutes (no API cost — uses cached odds)
  runAlertScan();
  intervals.push(setInterval(runAlertScan, 5 * 60 * 1000));

  // 3. Auto CLV capture every 2 minutes (DB required)
  if (isDatabaseConfigured()) {
    runClvCapture();
    intervals.push(setInterval(runClvCapture, 2 * 60 * 1000));
  } else {
    console.error("[Background] No DATABASE_URL — CLV auto-capture disabled");
  }

  // 4. Opening line capture every 4 hours (was 30min — opening lines only
  //    matter once per game; 30min was wasting quota on duplicate captures).
  if (isDatabaseConfigured()) {
    setTimeout(runOpeningLineCapture, 60 * 1000);
    intervals.push(setInterval(runOpeningLineCapture, 4 * 60 * 60 * 1000));
  }

  // 5. Auto-settle bets every 10 minutes (pulls final scores, settles pending bets)
  if (isDatabaseConfigured()) {
    setTimeout(runAutoSettle, 60 * 1000); // Delay 1 min to let other services initialize
    intervals.push(setInterval(runAutoSettle, 10 * 60 * 1000));
  }

  // 6. Enhanced CLV capture every 3 minutes (works without game_date)
  if (isDatabaseConfigured()) {
    runEnhancedClvCapture();
    intervals.push(setInterval(runEnhancedClvCapture, 3 * 60 * 1000));
  }

  // 7. Player-stat backfill — daily incremental (last 3 days), to keep
  //    prop_hit_rates fresh without thrashing the free APIs. Bigger initial
  //    backfill should be triggered via the backfill_player_history MCP tool.
  if (isDatabaseConfigured()) {
    setTimeout(runIncrementalBackfill, 5 * 60 * 1000); // 5min after boot
    intervals.push(setInterval(runIncrementalBackfill, 24 * 60 * 60 * 1000));
  }

  // 8. Steam-move scanner — every 5 minutes. Detects synchronized sharp moves
  //    in the last 30min of line_history and fires steam-type webhook alerts.
  if (isDatabaseConfigured()) {
    setTimeout(runSteamScanSafe, 7 * 60 * 1000); // delay 7min so line_history has data
    intervals.push(setInterval(runSteamScanSafe, 5 * 60 * 1000));
  }

  // 9. Live in-play drift capture — every 60s, picks up live bets from the
  //    1-15min window and records the no-vig prob shift.
  if (isDatabaseConfigured()) {
    intervals.push(setInterval(runLiveDriftSafe, 60 * 1000));
  }

  console.error("[Background] All services started");
}

async function runLiveDriftSafe(): Promise<void> {
  try {
    const r = await runLiveDriftCapture();
    if (r.updated > 0) console.error(`[LiveDrift] Updated ${r.updated}/${r.processed} live bets`);
  } catch (err) {
    console.error("[LiveDrift] error:", err);
  }
}

async function runSteamScanSafe(): Promise<void> {
  try {
    const r = await runSteamScan();
    if (r.steam_signals.length > 0) {
      console.error(`[Steam] ${r.steam_signals.length} signals; ${r.webhooks_fired} webhooks fired`);
    }
  } catch (err) {
    console.error("[Steam] scan failed:", err);
  }
}

async function runIncrementalBackfill(): Promise<void> {
  try {
    const result = await runBackfill({
      sports: ["nba", "mlb", "nhl"], // NFL handled weekly via the tool / UI
      days_back: 3,
    });
    console.error(`[Backfill] Daily: inserted ${result.total_rows_inserted} rows; table size ${result.current_table_size}`);
  } catch (err) {
    console.error("[Backfill] Daily incremental failed:", err);
  }
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
    if (!quotaSafe()) return;
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

        // No-vig CLV: use opposing Pinnacle outcome to de-vig the closing line.
        let noVigClv: number | null = null;
        let closingNoVigProb: number | null = null;
        const opposing = pinnacle.outcomes.find((o) => o.name !== outcome.name);
        if (opposing) {
          const closingNoVig = noVigProb2Way(closingLine, opposing.price).toNumber();
          closingNoVigProb = Number(closingNoVig.toFixed(4));
          const userImplied = americanToImpliedProb(betOdds).toNumber();
          const userNoVigApprox = userImplied / 1.0225;
          noVigClv = Number(((closingNoVig - userNoVigApprox) * 100).toFixed(3));
        }

        await query(
          `UPDATE bets
              SET closing_line = $1,
                  clv = $2,
                  no_vig_clv = COALESCE($3, no_vig_clv),
                  closing_pinnacle_no_vig_prob = COALESCE($4, closing_pinnacle_no_vig_prob)
            WHERE id = $5`,
          [closingLine, clv, noVigClv, closingNoVigProb, bet.id]
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
