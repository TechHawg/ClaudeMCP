/**
 * NHL backfill via api-web.nhle.com (free, no key required).
 *
 * Strategy: walk daily schedule → boxscore per game → player skater/goalie stats.
 *
 * Endpoints:
 *   - GET https://api-web.nhle.com/v1/schedule/YYYY-MM-DD
 *   - GET https://api-web.nhle.com/v1/gamecenter/{gameId}/boxscore
 */

import axios from "axios";
import { upsertStatBatch, sleep, isoDate, type PropStatRecord } from "./util.js";

const SCHEDULE = (date: string) => `https://api-web.nhle.com/v1/schedule/${date}`;
const BOX = (gameId: number) => `https://api-web.nhle.com/v1/gamecenter/${gameId}/boxscore`;

export async function backfillNHL(params: {
  days_back?: number;
  source_label?: string;
} = {}): Promise<{ days: number; rows_inserted: number; api_calls: number }> {
  const days = params.days_back ?? 60;
  const source = params.source_label ?? "nhl_api";
  let totalInserted = 0;
  let apiCalls = 0;
  const today = new Date();

  for (let d = 0; d < days; d++) {
    const date = isoDate(new Date(today.getTime() - d * 24 * 3600 * 1000));
    try {
      const sched = await axios.get(SCHEDULE(date), { timeout: 15000 });
      apiCalls++;

      const weeks = sched.data?.gameWeek ?? [];
      const dayBlock = weeks.find((w: { date: string }) => w.date === date);
      const games = dayBlock?.games ?? [];

      for (const g of games) {
        const gameId = g.id;
        const state = g.gameState;
        if (state !== "OFF" && state !== "FINAL") continue;
        const home = g.homeTeam?.name?.default ?? "Home";
        const away = g.awayTeam?.name?.default ?? "Away";
        const gameLabel = `${away} @ ${home}`;

        try {
          const box = await axios.get(BOX(gameId), { timeout: 15000 });
          apiCalls++;
          const data = box.data;
          const records: PropStatRecord[] = [];

          // playerByGameStats has structure { homeTeam: { forwards, defense, goalies }, awayTeam: ... }
          const groups = data?.playerByGameStats;
          if (!groups) continue;

          for (const teamSide of ["homeTeam", "awayTeam"] as const) {
            const team = groups[teamSide];
            if (!team) continue;

            const skaters = [...(team.forwards ?? []), ...(team.defense ?? [])];
            for (const sk of skaters) {
              const name = sk.name?.default ?? sk.name?.en ?? "";
              if (!name) continue;
              const goals = numOr(sk.goals);
              const assists = numOr(sk.assists);
              const points = (goals ?? 0) + (assists ?? 0);
              const shots = numOr(sk.shots);
              const blocked = numOr(sk.blockedShots);
              const hits = numOr(sk.hits);
              const pim = numOr(sk.pim);

              const markets: Array<{ market: string; value: number | null }> = [
                { market: "player_goals", value: goals },
                { market: "player_assists", value: assists },
                { market: "player_points", value: points }, // G+A
                { market: "player_shots_on_goal", value: shots },
                { market: "player_blocked_shots", value: blocked },
                { market: "player_hits", value: hits },
                { market: "player_penalty_minutes", value: pim },
              ];
              for (const m of markets) {
                if (m.value == null || Number.isNaN(m.value)) continue;
                records.push({
                  player_name: name,
                  sport: "nhl",
                  market: m.market,
                  actual_value: m.value,
                  game_date: date,
                  game: gameLabel,
                  source,
                });
              }
            }

            for (const gk of team.goalies ?? []) {
              const name = gk.name?.default ?? gk.name?.en ?? "";
              if (!name) continue;
              // saves and shotsAgainst are common fields
              const saves = numOr(gk.saves);
              const goalsAgainst = numOr(gk.goalsAgainst);
              const markets: Array<{ market: string; value: number | null }> = [
                { market: "goalie_saves", value: saves },
                { market: "goalie_goals_against", value: goalsAgainst },
              ];
              for (const m of markets) {
                if (m.value == null || Number.isNaN(m.value)) continue;
                records.push({
                  player_name: name,
                  sport: "nhl",
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
          console.error(`[Backfill/NHL] game ${gameId} failed:`, err instanceof Error ? err.message : err);
        }
      }
      await sleep(150);
    } catch (err) {
      console.error(`[Backfill/NHL] schedule ${date} failed:`, err instanceof Error ? err.message : err);
    }
  }

  return { days, rows_inserted: totalInserted, api_calls: apiCalls };
}

function numOr(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
