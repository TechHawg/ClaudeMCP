/**
 * MLB backfill via statsapi.mlb.com (free, no key required).
 *
 * Strategy: pull the daily schedule with hydrate=boxscore for each date, then
 * iterate teams → batters/pitchers → stat lines. Statsapi returns full game
 * box scores per team, which is exactly what we need for prop hit rates.
 *
 * Endpoint: GET https://statsapi.mlb.com/api/v1/schedule?date=YYYY-MM-DD&sportId=1&hydrate=team(boxscore)
 *           GET https://statsapi.mlb.com/api/v1/game/{gamePk}/boxscore (preferred — more detail)
 */

import axios from "axios";
import { upsertStatBatch, sleep, isoDate, type PropStatRecord } from "./util.js";

const SCHEDULE = "https://statsapi.mlb.com/api/v1/schedule";
const BOXSCORE = (gamePk: number) => `https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`;

export async function backfillMLB(params: {
  days_back?: number;
  source_label?: string;
} = {}): Promise<{ days: number; rows_inserted: number; api_calls: number }> {
  const days = params.days_back ?? 60;
  const source = params.source_label ?? "mlb_statsapi";
  let totalInserted = 0;
  let apiCalls = 0;
  const today = new Date();

  for (let d = 0; d < days; d++) {
    const date = isoDate(new Date(today.getTime() - d * 24 * 3600 * 1000));
    try {
      const sched = await axios.get(SCHEDULE, {
        params: { date, sportId: 1 },
        timeout: 15000,
      });
      apiCalls++;

      const dates = sched.data?.dates ?? [];
      for (const dateBlock of dates) {
        for (const game of dateBlock.games ?? []) {
          if (game.status?.detailedState !== "Final") continue;
          const gamePk = game.gamePk;
          const homeName = game.teams?.home?.team?.name ?? "Home";
          const awayName = game.teams?.away?.team?.name ?? "Away";
          const gameLabel = `${awayName} @ ${homeName}`;

          try {
            const live = await axios.get(BOXSCORE(gamePk), { timeout: 15000 });
            apiCalls++;
            const teams = live.data?.liveData?.boxscore?.teams;
            if (!teams) continue;
            const records: PropStatRecord[] = [];

            for (const teamSide of ["home", "away"] as const) {
              const teamData = teams[teamSide];
              if (!teamData) continue;
              const players = teamData.players as Record<string, unknown> | undefined;
              if (!players) continue;

              for (const pid in players) {
                const p = players[pid] as Record<string, unknown>;
                const personName = ((p.person as Record<string, unknown>)?.fullName as string) ?? "";
                if (!personName) continue;
                const stats = p.stats as Record<string, Record<string, unknown>> | undefined;
                const batting = stats?.batting ?? {};
                const pitching = stats?.pitching ?? {};

                const markets: Array<{ market: string; value: number | null }> = [
                  // Batter markets
                  { market: "batter_hits", value: numOr(batting.hits) },
                  { market: "batter_total_bases", value: numOr(batting.totalBases) },
                  { market: "batter_home_runs", value: numOr(batting.homeRuns) },
                  { market: "batter_rbis", value: numOr(batting.rbi) },
                  { market: "batter_runs_scored", value: numOr(batting.runs) },
                  { market: "batter_strikeouts", value: numOr(batting.strikeOuts) },
                  { market: "batter_walks", value: numOr(batting.baseOnBalls) },
                  { market: "batter_stolen_bases", value: numOr(batting.stolenBases) },
                  // Pitcher markets — only if they pitched
                  { market: "pitcher_strikeouts", value: pitching.strikeOuts != null ? numOr(pitching.strikeOuts) : null },
                  { market: "pitcher_outs", value: pitching.outs != null ? numOr(pitching.outs) : null },
                  { market: "pitcher_hits_allowed", value: pitching.hits != null ? numOr(pitching.hits) : null },
                  { market: "pitcher_earned_runs", value: pitching.earnedRuns != null ? numOr(pitching.earnedRuns) : null },
                ];

                for (const m of markets) {
                  if (m.value == null || Number.isNaN(m.value)) continue;
                  records.push({
                    player_name: personName,
                    sport: "mlb",
                    market: m.market,
                    actual_value: m.value,
                    game_date: date,
                    game: gameLabel,
                    source,
                  });
                }
              }
            }

            totalInserted += await upsertStatBatch(records);
            await sleep(150);
          } catch (err) {
            console.error(`[Backfill/MLB] game ${gamePk} failed:`, err instanceof Error ? err.message : err);
          }
        }
      }
      await sleep(150);
    } catch (err) {
      console.error(`[Backfill/MLB] schedule ${date} failed:`, err instanceof Error ? err.message : err);
    }
  }

  return { days, rows_inserted: totalInserted, api_calls: apiCalls };
}

function numOr(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
