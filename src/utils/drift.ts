/**
 * Pinnacle line-drift analysis.
 *
 * The single highest-leverage pre-bet defense is "is the sharp consensus
 * moving away from my side in the last hour?" If it is, your edge is already
 * gone — the bet has aged out.
 *
 * This module reads line_history (populated automatically by getLiveOdds)
 * and computes the no-vig probability movement at sharp books for a given
 * (game_id, market, side) over a lookback window.
 */

import { isDatabaseConfigured, query } from "../db/client.js";
import { noVigProb2Way } from "./helpers.js";

export interface PinnacleDriftResult {
  game_id: string;
  market: string;
  side: string;
  /** No-vig prob for `side` at the start of the window. */
  open_prob: number | null;
  /** No-vig prob for `side` at the end of the window. */
  current_prob: number | null;
  /** Movement in percentage points (current - open). Positive = sharp money on YOUR side. */
  drift_pct: number | null;
  /** Number of distinct snapshots used. */
  snapshots: number;
  /** Whether enough data exists to be meaningful. */
  reliable: boolean;
}

const SHARP_BOOKS = ["pinnacle", "circasports", "circa", "bookmaker_eu", "bookmaker.eu", "betcris", "matchbook"];

/**
 * Compute no-vig probability drift on a given side over the last `hoursBack` hours.
 * Returns null `drift_pct` if insufficient data.
 */
export async function getPinnacleDrift(params: {
  game_id: string;
  market: string;
  side: string;
  hours_back?: number;
}): Promise<PinnacleDriftResult> {
  const hoursBack = params.hours_back ?? 1;
  const result: PinnacleDriftResult = {
    game_id: params.game_id,
    market: params.market,
    side: params.side,
    open_prob: null,
    current_prob: null,
    drift_pct: null,
    snapshots: 0,
    reliable: false,
  };

  if (!isDatabaseConfigured()) return result;

  try {
    // Pull line_history for sharp books for the side and (computed) opposing side.
    // We compute drift for "side" but need both prices to de-vig.
    const rows = await query<{
      book: string;
      side: string;
      odds: number;
      recorded_at: string | Date;
    }>(
      `SELECT book, side, odds, recorded_at
         FROM line_history
        WHERE game_id = $1
          AND market = $2
          AND lower(book) = ANY($3::text[])
          AND recorded_at > NOW() - ($4::int || ' hours')::interval
        ORDER BY recorded_at ASC`,
      [params.game_id, params.market, SHARP_BOOKS, hoursBack]
    );

    if (rows.length < 2) return result;

    // Bucket by timestamp (rounded to minute) and book; we need pairs of side+opposing.
    // Build a map: timestamp_minute → { book → { sideA: odds, sideB: odds } }
    interface BookSnapshot { sideA?: number; sideB?: number }
    const buckets = new Map<string, Map<string, BookSnapshot>>();

    for (const r of rows) {
      const tsKey = new Date(r.recorded_at as string | Date).toISOString().slice(0, 16); // minute precision
      if (!buckets.has(tsKey)) buckets.set(tsKey, new Map());
      const bookMap = buckets.get(tsKey)!;
      const book = r.book.toLowerCase();
      if (!bookMap.has(book)) bookMap.set(book, {});
      const snap = bookMap.get(book)!;
      const sideMatches = r.side.toLowerCase() === params.side.toLowerCase();
      if (sideMatches) snap.sideA = Number(r.odds);
      else snap.sideB = Number(r.odds);
    }

    // For each bucket, compute median no-vig prob across sharp books that have both sides.
    interface Point { ts: string; probA: number }
    const series: Point[] = [];
    for (const [ts, bookMap] of buckets) {
      const probs: number[] = [];
      for (const [, snap] of bookMap) {
        if (snap.sideA != null && snap.sideB != null) {
          probs.push(noVigProb2Way(snap.sideA, snap.sideB).toNumber());
        }
      }
      if (probs.length > 0) {
        probs.sort((a, b) => a - b);
        const mid = Math.floor(probs.length / 2);
        const med = probs.length % 2 === 0 ? (probs[mid - 1] + probs[mid]) / 2 : probs[mid];
        series.push({ ts, probA: med });
      }
    }

    if (series.length < 2) return result;

    series.sort((a, b) => a.ts.localeCompare(b.ts));
    const open = series[0].probA;
    const current = series[series.length - 1].probA;

    result.open_prob = Number(open.toFixed(4));
    result.current_prob = Number(current.toFixed(4));
    result.drift_pct = Number(((current - open) * 100).toFixed(3));
    result.snapshots = series.length;
    // Reliable with ≥2 snapshots when the gap is meaningful (>=10 minutes).
    // Pre-iter5 this required 3 snapshots which was unrealistic in the first
    // hour after server start.
    const firstTs = new Date(series[0].ts + ":00Z").getTime();
    const lastTs = new Date(series[series.length - 1].ts + ":00Z").getTime();
    const gapMinutes = (lastTs - firstTs) / 60000;
    result.reliable = series.length >= 2 && gapMinutes >= 10;
  } catch (err) {
    console.error("[Drift] query failed:", err);
  }

  return result;
}
