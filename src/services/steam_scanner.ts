/**
 * Steam-move scanner.
 *
 * Reads line_history every 5 minutes and detects synchronized sharp moves:
 * "≥3 sharp books moved no-vig probability for the same (game, market, side)
 * by ≥1.5 percentage points in the same direction within the last 30 minutes."
 *
 * When a steam move is found, fires any configured webhooks (alerts table)
 * for that sport. Steam moves are time-sensitive — books typically follow
 * within minutes, so retail bettors have a small window to grab the prior price.
 */

import axios from "axios";
import { isDatabaseConfigured, query } from "../db/client.js";
import { noVigProb2Way } from "../utils/helpers.js";

const SHARP_BOOKS = ["pinnacle", "circasports", "circa", "bookmaker_eu", "bookmaker.eu", "betcris", "matchbook"];
const STEAM_DRIFT_THRESHOLD_PCT = 1.5; // pct points
const STEAM_LOOKBACK_MINUTES = 30;
const STEAM_MIN_BOOKS = 3;

export interface SteamSignal {
  game_id: string;
  market: string;
  side: string;
  direction: "up" | "down"; // up = prob increased on this side
  avg_drift_pct: number;
  books: string[];
  detected_at: string;
}

export async function runSteamScan(): Promise<{ steam_signals: SteamSignal[]; webhooks_fired: number }> {
  if (!isDatabaseConfigured()) return { steam_signals: [], webhooks_fired: 0 };

  // Pull the last 30 min of sharp-book line history.
  const rows = await query<{
    game_id: string;
    market: string;
    book: string;
    side: string;
    odds: number;
    recorded_at: string;
  }>(
    `SELECT game_id, market, book, side, odds, recorded_at
       FROM line_history
      WHERE recorded_at > NOW() - ($1::int || ' minutes')::interval
        AND lower(book) = ANY($2::text[])
      ORDER BY recorded_at ASC`,
    [STEAM_LOOKBACK_MINUTES, SHARP_BOOKS]
  );

  if (rows.length < 4) return { steam_signals: [], webhooks_fired: 0 };

  // Bucket by (game_id, market, book, side) → time-ordered odds list.
  type Pair = { sideA?: number; sideB?: number };
  const buckets = new Map<string, Map<string, { open: Pair; current: Pair }>>();
  // Outer key: game_id|market|sideA-name; inner key: book

  // First pass: identify outcome names per (game, market) so we can pair sides.
  const outcomeNamesByGameMkt = new Map<string, Set<string>>();
  for (const r of rows) {
    const k = `${r.game_id}|${r.market}`;
    if (!outcomeNamesByGameMkt.has(k)) outcomeNamesByGameMkt.set(k, new Set());
    outcomeNamesByGameMkt.get(k)!.add(r.side);
  }

  // For each (game, market), pick a primary side (alphabetically first) and pair vs others.
  // For 2-way markets there's exactly one opposing side; for n-way we degrade to first opposing.
  for (const [gameMkt, sides] of outcomeNamesByGameMkt) {
    const sortedSides = [...sides].sort();
    if (sortedSides.length < 2) continue;
    const sideA = sortedSides[0];
    const sideB = sortedSides[1]; // closest opposing side

    const [game_id, market] = gameMkt.split("|");

    // For each book, find earliest and latest snapshots that have BOTH sides.
    const byBook = new Map<string, { open: Pair; current: Pair }>();
    const relevant = rows.filter((r) => r.game_id === game_id && r.market === market);
    // Build per-book per-timestamp pairs
    const perBookTime = new Map<string, Map<string, Pair>>();
    for (const r of relevant) {
      const tsMin = r.recorded_at.slice(0, 16); // minute precision
      const book = r.book.toLowerCase();
      if (!perBookTime.has(book)) perBookTime.set(book, new Map());
      const tmap = perBookTime.get(book)!;
      if (!tmap.has(tsMin)) tmap.set(tsMin, {});
      const p = tmap.get(tsMin)!;
      if (r.side === sideA) p.sideA = Number(r.odds);
      else if (r.side === sideB) p.sideB = Number(r.odds);
    }

    for (const [book, tmap] of perBookTime) {
      const sortedTs = [...tmap.entries()].sort(([a], [b]) => a.localeCompare(b));
      const completePairs = sortedTs.filter(([, p]) => p.sideA != null && p.sideB != null);
      if (completePairs.length < 2) continue;
      byBook.set(book, {
        open: completePairs[0][1],
        current: completePairs[completePairs.length - 1][1],
      });
    }

    if (byBook.size < STEAM_MIN_BOOKS) continue;

    // Compute drift on sideA at each book.
    const drifts: { book: string; drift: number }[] = [];
    for (const [book, snap] of byBook) {
      const open = noVigProb2Way(snap.open.sideA!, snap.open.sideB!).toNumber();
      const cur = noVigProb2Way(snap.current.sideA!, snap.current.sideB!).toNumber();
      drifts.push({ book, drift: (cur - open) * 100 });
    }

    // Steam = ≥3 books moved same direction by ≥ threshold.
    const upBooks = drifts.filter((d) => d.drift >= STEAM_DRIFT_THRESHOLD_PCT);
    const downBooks = drifts.filter((d) => d.drift <= -STEAM_DRIFT_THRESHOLD_PCT);

    const signals: SteamSignal[] = [];
    if (upBooks.length >= STEAM_MIN_BOOKS) {
      const avgDrift = upBooks.reduce((s, x) => s + x.drift, 0) / upBooks.length;
      signals.push({
        game_id, market, side: sideA, direction: "up",
        avg_drift_pct: Number(avgDrift.toFixed(2)),
        books: upBooks.map((x) => x.book),
        detected_at: new Date().toISOString(),
      });
    }
    if (downBooks.length >= STEAM_MIN_BOOKS) {
      const avgDrift = downBooks.reduce((s, x) => s + x.drift, 0) / downBooks.length;
      // Down on sideA = up on sideB
      signals.push({
        game_id, market, side: sideB, direction: "up",
        avg_drift_pct: Number((-avgDrift).toFixed(2)),
        books: downBooks.map((x) => x.book),
        detected_at: new Date().toISOString(),
      });
    }

    if (signals.length === 0) continue;

    // Persist + fire webhooks
    const fired = await deliverSteamSignals(signals);
    return { steam_signals: signals, webhooks_fired: fired };
  }

  return { steam_signals: [], webhooks_fired: 0 };
}

async function deliverSteamSignals(signals: SteamSignal[]): Promise<number> {
  // Fire any active "steam" alerts. Each alert has a sport filter (nba, mlb, etc.)
  // We don't know which sport from game_id alone; we'll match against the snapshot
  // sport via line_history join.
  const alerts = await query<{
    id: number;
    sport: string;
    threshold: string | number;
    webhook_url: string;
    webhook_type: string;
  }>(
    `SELECT id, sport, threshold, webhook_url, webhook_type
       FROM alerts
      WHERE active = true AND alert_type = 'steam'`
  );
  if (alerts.length === 0) return 0;

  let fired = 0;
  for (const alert of alerts) {
    const matching = signals.filter(
      (s) => Math.abs(s.avg_drift_pct) >= Number(alert.threshold)
    );
    if (matching.length === 0) continue;

    const summary = matching
      .map((s) => `${s.side} (${s.direction}, +${s.avg_drift_pct.toFixed(2)}% across ${s.books.length} sharp books)`)
      .join("\n  ");
    const text = `**Steam moves detected**\n  ${summary}`;

    try {
      if (alert.webhook_type === "discord") {
        await axios.post(alert.webhook_url, { content: text }, { timeout: 10000 });
      } else if (alert.webhook_type === "slack") {
        await axios.post(alert.webhook_url, { text }, { timeout: 10000 });
      } else {
        await axios.post(alert.webhook_url, { type: "steam", signals: matching }, { timeout: 10000 });
      }
      await query(`UPDATE alerts SET last_triggered = NOW() WHERE id = $1`, [alert.id]);
      fired++;
    } catch (err) {
      console.error(`[Steam] Webhook ${alert.id} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return fired;
}
