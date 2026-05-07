/**
 * Backfill coordinator. Dispatches to per-sport modules and aggregates the
 * results into a single response for the MCP tool.
 */

import { backfillNBA } from "./nba.js";
import { backfillMLB } from "./mlb.js";
import { backfillNHL } from "./nhl.js";
import { backfillNFL } from "./nfl.js";
import { isDatabaseConfigured, query } from "../../db/client.js";

export interface BackfillResult {
  sport: string;
  ok: boolean;
  rows_inserted: number;
  details: Record<string, unknown>;
  error?: string;
}

export interface BackfillSummary {
  started_at: string;
  finished_at: string;
  results: BackfillResult[];
  total_rows_inserted: number;
  current_table_size: number;
  notes: string[];
}

export async function runBackfill(params: {
  sports?: string[];
  days_back?: number;
  nfl_seasons?: number[];
} = {}): Promise<BackfillSummary> {
  const sports = (params.sports ?? ["nba", "mlb", "nhl", "nfl"]).map((s) => s.toLowerCase());
  const days = params.days_back ?? 60;
  const start = new Date().toISOString();
  const results: BackfillResult[] = [];
  const notes: string[] = [];

  if (!isDatabaseConfigured()) {
    notes.push("DATABASE_URL not set — backfill cannot persist results.");
  }

  // Run sequentially to avoid hammering rate-limited free APIs.
  if (sports.includes("nba")) {
    try {
      const r = await backfillNBA({ days_back: days });
      results.push({ sport: "nba", ok: true, rows_inserted: r.rows_inserted, details: r });
    } catch (err) {
      results.push({ sport: "nba", ok: false, rows_inserted: 0, details: {}, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (sports.includes("mlb")) {
    try {
      const r = await backfillMLB({ days_back: days });
      results.push({ sport: "mlb", ok: true, rows_inserted: r.rows_inserted, details: r });
    } catch (err) {
      results.push({ sport: "mlb", ok: false, rows_inserted: 0, details: {}, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (sports.includes("nhl")) {
    try {
      const r = await backfillNHL({ days_back: days });
      results.push({ sport: "nhl", ok: true, rows_inserted: r.rows_inserted, details: r });
    } catch (err) {
      results.push({ sport: "nhl", ok: false, rows_inserted: 0, details: {}, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (sports.includes("nfl")) {
    try {
      const r = await backfillNFL({ seasons: params.nfl_seasons });
      results.push({ sport: "nfl", ok: true, rows_inserted: r.rows_inserted, details: r });
    } catch (err) {
      results.push({ sport: "nfl", ok: false, rows_inserted: 0, details: {}, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const total = results.reduce((s, r) => s + r.rows_inserted, 0);

  // Snapshot current table size for visibility
  let tableSize = 0;
  if (isDatabaseConfigured()) {
    try {
      const rows = await query<{ n: string | number }>(`SELECT COUNT(*) AS n FROM prop_hit_rates`);
      tableSize = Number(rows[0]?.n ?? 0);
    } catch { /* ignore */ }
  }

  return {
    started_at: start,
    finished_at: new Date().toISOString(),
    results,
    total_rows_inserted: total,
    current_table_size: tableSize,
    notes,
  };
}
