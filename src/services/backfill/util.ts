/**
 * Shared utilities for the prop_hit_rates backfill modules.
 */

import { isDatabaseConfigured, query } from "../../db/client.js";

export interface PropStatRecord {
  player_name: string;
  sport: string;
  market: string;
  actual_value: number;
  game_date: string; // YYYY-MM-DD
  game?: string;
  source: string;
}

/** Insert (or skip on conflict) a batch of stat rows. Returns inserted count. */
export async function upsertStatBatch(rows: PropStatRecord[]): Promise<number> {
  if (!isDatabaseConfigured() || rows.length === 0) return 0;

  // Postgres limits to 65535 params per statement; insert in chunks.
  const CHUNK = 500;
  let inserted = 0;

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const placeholders: string[] = [];
    const args: unknown[] = [];
    let p = 1;
    for (const r of chunk) {
      placeholders.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
      args.push(
        r.player_name,
        r.sport,
        r.market,
        r.actual_value,
        r.game_date,
        r.game ?? null,
        r.source,
      );
    }
    const result = await query<{ id: number }>(
      `INSERT INTO prop_hit_rates
        (player_name, sport, market, actual_value, game_date, game, source)
       VALUES ${placeholders.join(", ")}
       ON CONFLICT (player_name, sport, market, game_date) DO NOTHING
       RETURNING id`,
      args
    );
    inserted += result.length;
  }
  return inserted;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Subtract n days from today and return YYYY-MM-DD. */
export function daysAgoISO(n: number): string {
  return isoDate(new Date(Date.now() - n * 24 * 3600 * 1000));
}
