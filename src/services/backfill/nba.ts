/**
 * NBA backfill via balldontlie.io (free, no key required for basic endpoints).
 *
 * Endpoint:  GET https://api.balldontlie.io/v1/stats?dates[]=YYYY-MM-DD&per_page=100&cursor=...
 * Returns box scores. We pluck per-player stats and write to prop_hit_rates.
 *
 * Rate limit (free tier): 5 req/sec, 30/min. We throttle ~250ms between calls.
 *
 * BALLDONTLIE_API_KEY is supported (Authorization header) but optional.
 */

import axios from "axios";
import { upsertStatBatch, sleep, daysAgoISO, isoDate, type PropStatRecord } from "./util.js";

interface BdlStat {
  player: { first_name: string; last_name: string };
  game: { date: string };
  team: { full_name: string };
  pts: number; reb: number; ast: number;
  stl: number; blk: number; turnover: number;
  fg3m: number; fg3a: number;
  min: string; // "30:21"
}

interface BdlResponse {
  data: BdlStat[];
  meta: { next_cursor?: number };
}

const BASE = "https://api.balldontlie.io/v1/stats";

export async function backfillNBA(params: {
  days_back?: number;
  source_label?: string;
} = {}): Promise<{ days: number; rows_inserted: number; api_calls: number }> {
  const days = params.days_back ?? 60;
  const source = params.source_label ?? "balldontlie";
  const apiKey = process.env.BALLDONTLIE_API_KEY;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) headers.Authorization = apiKey;

  let totalInserted = 0;
  let apiCalls = 0;
  const today = new Date();

  for (let d = 0; d < days; d++) {
    const date = isoDate(new Date(today.getTime() - d * 24 * 3600 * 1000));
    let cursor: number | undefined;

    do {
      try {
        const resp = await axios.get<BdlResponse>(BASE, {
          params: {
            "dates[]": date,
            per_page: 100,
            ...(cursor != null ? { cursor } : {}),
          },
          headers,
          timeout: 15000,
        });
        apiCalls++;

        const stats = resp.data?.data ?? [];
        const records: PropStatRecord[] = [];
        for (const s of stats) {
          const playerName = `${s.player.first_name} ${s.player.last_name}`.trim();
          const game = s.team.full_name;

          // One row per market — write the markets that actually correspond to
          // The Odds API's player prop markets we care about.
          const markets: Array<{ market: string; value: number | null }> = [
            { market: "player_points", value: s.pts },
            { market: "player_rebounds", value: s.reb },
            { market: "player_assists", value: s.ast },
            { market: "player_threes", value: s.fg3m },
            { market: "player_steals", value: s.stl },
            { market: "player_blocks", value: s.blk },
            // Combos
            { market: "player_points_rebounds", value: (s.pts ?? 0) + (s.reb ?? 0) },
            { market: "player_points_assists", value: (s.pts ?? 0) + (s.ast ?? 0) },
            { market: "player_points_rebounds_assists", value: (s.pts ?? 0) + (s.reb ?? 0) + (s.ast ?? 0) },
          ];

          for (const m of markets) {
            if (m.value == null || Number.isNaN(m.value)) continue;
            records.push({
              player_name: playerName,
              sport: "nba",
              market: m.market,
              actual_value: m.value,
              game_date: date,
              game,
              source,
            });
          }
        }

        const inserted = await upsertStatBatch(records);
        totalInserted += inserted;

        cursor = resp.data?.meta?.next_cursor;
        await sleep(250); // be nice to free tier
      } catch (err) {
        console.error(`[Backfill/NBA] ${date} failed:`, err instanceof Error ? err.message : err);
        cursor = undefined;
      }
    } while (cursor != null);
  }

  return { days, rows_inserted: totalInserted, api_calls: apiCalls };
}
