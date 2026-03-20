/**
 * Historical Line Query Tool
 * Reads from the line_history table to show how lines moved over time.
 * Identifies steam moves, opening vs current line, and sharp action patterns.
 */

import { isDatabaseConfigured, query } from "../../db/client.js";
import DecimalLib from "decimal.js";
const Decimal = DecimalLib.default ?? DecimalLib;

// ── Types ────────────────────────────────────────────────────────────────────

interface LineSnapshot {
  book: string;
  side: string;
  line: number | null;
  odds: number;
  recorded_at: string;
}

interface LineMovement {
  side: string;
  book: string;
  open_odds: number;
  current_odds: number;
  change: number; // positive = moved in favor, negative = moved against
  open_time: string;
  latest_time: string;
  snapshots: number;
}

interface SteamMoveDetection {
  side: string;
  direction: string;
  books_moved: string[];
  avg_change: number;
  detected: boolean;
  message: string;
}

interface HistoryResult {
  game_id: string;
  market: string;
  movements: LineMovement[];
  steam_moves: SteamMoveDetection[];
  sharp_indicators: string[];
  summary: string;
}

// ── Implementation ───────────────────────────────────────────────────────────

export async function queryLineHistory(params: {
  game_id?: string;
  sport?: string;
  side?: string;
  market?: string;
  hours_back?: number;
}): Promise<HistoryResult | HistoryResult[]> {
  if (!isDatabaseConfigured()) {
    throw new Error(
      "Database not configured. Line history requires DATABASE_URL and recorded data from previous odds fetches."
    );
  }

  const market = params.market ?? "h2h";
  const hoursBack = params.hours_back ?? 48;

  // If game_id provided, get history for that specific game
  if (params.game_id) {
    return getGameHistory(params.game_id, market);
  }

  // Otherwise search by time window
  const cutoff = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();

  let sql = `
    SELECT DISTINCT game_id
    FROM line_history
    WHERE market = $1 AND recorded_at >= $2
  `;
  const sqlParams: unknown[] = [market, cutoff];

  if (params.side) {
    sql += ` AND LOWER(side) LIKE $3`;
    sqlParams.push(`%${params.side.toLowerCase()}%`);
  }

  sql += ` ORDER BY game_id LIMIT 20`;

  const gameIds = await query<{ game_id: string }>(sql, sqlParams);

  if (gameIds.length === 0) {
    return {
      game_id: "none",
      market,
      movements: [],
      steam_moves: [],
      sharp_indicators: [],
      summary: `No line history found for the past ${hoursBack} hours. Line data is recorded each time odds are fetched via get_live_odds.`,
    };
  }

  const results: HistoryResult[] = [];
  for (const { game_id } of gameIds.slice(0, 10)) {
    results.push(await getGameHistory(game_id, market));
  }

  return results;
}

// ── Get history for a specific game ──────────────────────────────────────────

async function getGameHistory(
  gameId: string,
  market: string
): Promise<HistoryResult> {
  const snapshots = await query<LineSnapshot>(
    `SELECT book, side, line, odds, recorded_at::text
     FROM line_history
     WHERE game_id = $1 AND market = $2
     ORDER BY recorded_at ASC`,
    [gameId, market]
  );

  if (snapshots.length === 0) {
    return {
      game_id: gameId,
      market,
      movements: [],
      steam_moves: [],
      sharp_indicators: [],
      summary: `No line history for game ${gameId}.`,
    };
  }

  // Group by book + side
  const groups: Record<string, LineSnapshot[]> = {};
  for (const s of snapshots) {
    const key = `${s.book}|${s.side}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(s);
  }

  // Calculate movements
  const movements: LineMovement[] = [];
  for (const [key, snaps] of Object.entries(groups)) {
    const [book, side] = key.split("|");
    const first = snaps[0];
    const last = snaps[snaps.length - 1];
    const change = last.odds - first.odds;

    movements.push({
      side,
      book,
      open_odds: first.odds,
      current_odds: last.odds,
      change,
      open_time: first.recorded_at,
      latest_time: last.recorded_at,
      snapshots: snaps.length,
    });
  }

  // Detect steam moves (3+ books moving same direction on same side within close timeframe)
  const steamMoves = detectSteamMoves(movements);

  // Identify sharp indicators
  const sharpIndicators = identifySharpIndicators(movements);

  // Build summary
  const totalMoves = movements.filter((m) => m.change !== 0).length;
  const bigMoves = movements.filter((m) => Math.abs(m.change) >= 10);
  let summary = `Game ${gameId}: ${snapshots.length} line snapshots across ${movements.length} book/side combos. `;
  summary += `${totalMoves} lines moved, ${bigMoves.length} significant moves (10+ cent change).`;

  if (steamMoves.some((s) => s.detected)) {
    summary += ` STEAM MOVE DETECTED.`;
  }
  if (sharpIndicators.length > 0) {
    summary += ` Sharp signals: ${sharpIndicators.join("; ")}.`;
  }

  return {
    game_id: gameId,
    market,
    movements: movements.sort((a, b) => Math.abs(b.change) - Math.abs(a.change)),
    steam_moves: steamMoves,
    sharp_indicators: sharpIndicators,
    summary,
  };
}

// ── Steam move detection ─────────────────────────────────────────────────────

function detectSteamMoves(movements: LineMovement[]): SteamMoveDetection[] {
  // Group movements by side
  const bySide: Record<string, LineMovement[]> = {};
  for (const m of movements) {
    if (!bySide[m.side]) bySide[m.side] = [];
    bySide[m.side].push(m);
  }

  const results: SteamMoveDetection[] = [];
  for (const [side, moves] of Object.entries(bySide)) {
    const movedUp = moves.filter((m) => m.change > 0);
    const movedDown = moves.filter((m) => m.change < 0);

    // Steam = 3+ books moved same direction
    if (movedUp.length >= 3) {
      const avgChange =
        movedUp.reduce((sum, m) => sum + m.change, 0) / movedUp.length;
      results.push({
        side,
        direction: "up (longer odds / more +)",
        books_moved: movedUp.map((m) => m.book),
        avg_change: parseFloat(avgChange.toFixed(1)),
        detected: true,
        message: `Steam move UP on ${side}: ${movedUp.length} books moved odds higher (avg ${avgChange > 0 ? "+" : ""}${avgChange.toFixed(1)}).`,
      });
    }

    if (movedDown.length >= 3) {
      const avgChange =
        movedDown.reduce((sum, m) => sum + m.change, 0) / movedDown.length;
      results.push({
        side,
        direction: "down (shorter odds / more -)",
        books_moved: movedDown.map((m) => m.book),
        avg_change: parseFloat(avgChange.toFixed(1)),
        detected: true,
        message: `Steam move DOWN on ${side}: ${movedDown.length} books shortened odds (avg ${avgChange.toFixed(1)}).`,
      });
    }

    if (movedUp.length < 3 && movedDown.length < 3) {
      results.push({
        side,
        direction: "none",
        books_moved: [],
        avg_change: 0,
        detected: false,
        message: `No steam move detected on ${side}.`,
      });
    }
  }

  return results;
}

// ── Sharp indicators ─────────────────────────────────────────────────────────

const SHARP_BOOKS = ["pinnacle", "circa", "bookmaker", "betcris", "cris"];
const PUBLIC_BOOKS = ["draftkings", "fanduel", "betmgm", "caesars", "pointsbet"];

function identifySharpIndicators(movements: LineMovement[]): string[] {
  const indicators: string[] = [];

  // Check if sharp books moved opposite to public books (Reverse Line Movement)
  for (const side of [...new Set(movements.map((m) => m.side))]) {
    const sideMoves = movements.filter((m) => m.side === side);
    const sharpMoves = sideMoves.filter((m) =>
      SHARP_BOOKS.some((sb) => m.book.toLowerCase().includes(sb))
    );
    const publicMoves = sideMoves.filter((m) =>
      PUBLIC_BOOKS.some((pb) => m.book.toLowerCase().includes(pb))
    );

    if (sharpMoves.length > 0 && publicMoves.length > 0) {
      const sharpDirection = sharpMoves.reduce((sum, m) => sum + m.change, 0);
      const publicDirection = publicMoves.reduce((sum, m) => sum + m.change, 0);

      if (
        (sharpDirection > 0 && publicDirection < 0) ||
        (sharpDirection < 0 && publicDirection > 0)
      ) {
        indicators.push(
          `RLM on ${side}: sharp books moved ${sharpDirection > 0 ? "up" : "down"} while public books moved ${publicDirection > 0 ? "up" : "down"}`
        );
      }
    }

    // Big Pinnacle move = sharp signal
    const pinnacleMoves = sideMoves.filter((m) =>
      m.book.toLowerCase().includes("pinnacle")
    );
    for (const pm of pinnacleMoves) {
      if (Math.abs(pm.change) >= 15) {
        indicators.push(
          `Large Pinnacle move on ${side}: ${pm.open_odds} → ${pm.current_odds} (${pm.change > 0 ? "+" : ""}${pm.change})`
        );
      }
    }
  }

  return indicators;
}
