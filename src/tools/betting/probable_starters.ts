/**
 * Probable starters — for MLB and NHL where the identity of the starting
 * pitcher / goalie materially changes prop fair lines.
 *
 * Free sources (no API key required):
 *   - MLB: statsapi.mlb.com (probable pitcher per team via schedule hydrate)
 *   - NHL: api-web.nhle.com (gamecenter "rightRail" / boxscore preview)
 *
 * If you bet a goalie's saves prop without confirming he's actually starting,
 * you're betting blind — backups change everything. This tool returns
 * confirmed/probable starters for today's games so the prop scanner can flag
 * "starter unconfirmed" as a refusal reason.
 */

import axios from "axios";

export interface ProbableStarter {
  game: string;
  game_id?: string | number;
  team: string;
  player: string;
  status: "confirmed" | "probable" | "unknown";
  source: string;
}

export interface ProbableStartersResult {
  sport: string;
  date: string;
  starters: ProbableStarter[];
  notes: string[];
}

export async function getProbableStarters(params: {
  sport: string;
  date?: string; // YYYY-MM-DD; defaults to today
}): Promise<ProbableStartersResult> {
  const sport = params.sport.toLowerCase();
  const date = params.date ?? new Date().toISOString().slice(0, 10);
  const notes: string[] = [];

  if (sport === "mlb") {
    return await mlbProbablePitchers(date, notes);
  }
  if (sport === "nhl") {
    return await nhlProbableGoalies(date, notes);
  }

  notes.push(`Probable starters not implemented for sport "${sport}". Supported: mlb, nhl.`);
  return { sport, date, starters: [], notes };
}

// ── MLB ──────────────────────────────────────────────────────────────────────

async function mlbProbablePitchers(date: string, notes: string[]): Promise<ProbableStartersResult> {
  const starters: ProbableStarter[] = [];
  try {
    const resp = await axios.get(
      "https://statsapi.mlb.com/api/v1/schedule",
      {
        params: {
          date,
          sportId: 1,
          hydrate: "probablePitcher,team",
        },
        timeout: 15000,
      }
    );
    for (const dateBlock of resp.data?.dates ?? []) {
      for (const game of dateBlock.games ?? []) {
        const home = game.teams?.home?.team?.name ?? "Home";
        const away = game.teams?.away?.team?.name ?? "Away";
        const gameLabel = `${away} @ ${home}`;
        const homePitcher = game.teams?.home?.probablePitcher?.fullName;
        const awayPitcher = game.teams?.away?.probablePitcher?.fullName;
        if (homePitcher) {
          starters.push({
            game: gameLabel,
            game_id: game.gamePk,
            team: home,
            player: homePitcher,
            status: "probable",
            source: "mlb_statsapi",
          });
        }
        if (awayPitcher) {
          starters.push({
            game: gameLabel,
            game_id: game.gamePk,
            team: away,
            player: awayPitcher,
            status: "probable",
            source: "mlb_statsapi",
          });
        }
      }
    }
  } catch (err) {
    notes.push(`MLB probables fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { sport: "mlb", date, starters, notes };
}

// ── NHL ──────────────────────────────────────────────────────────────────────

async function nhlProbableGoalies(date: string, notes: string[]): Promise<ProbableStartersResult> {
  const starters: ProbableStarter[] = [];
  try {
    const sched = await axios.get(`https://api-web.nhle.com/v1/schedule/${date}`, { timeout: 15000 });
    const weeks = sched.data?.gameWeek ?? [];
    const dayBlock = weeks.find((w: { date: string }) => w.date === date);
    const games = dayBlock?.games ?? [];

    for (const g of games) {
      const home = g.homeTeam?.name?.default ?? "Home";
      const away = g.awayTeam?.name?.default ?? "Away";
      const gameLabel = `${away} @ ${home}`;

      // The right-rail endpoint includes "gameInfo" with starting goalies when available.
      try {
        const rr = await axios.get(`https://api-web.nhle.com/v1/gamecenter/${g.id}/right-rail`, { timeout: 15000 });
        const home_goalie = rr.data?.gameInfo?.homeTeam?.goalies?.[0];
        const away_goalie = rr.data?.gameInfo?.awayTeam?.goalies?.[0];
        if (home_goalie?.firstName?.default) {
          starters.push({
            game: gameLabel,
            game_id: g.id,
            team: home,
            player: `${home_goalie.firstName.default} ${home_goalie.lastName?.default ?? ""}`.trim(),
            status: home_goalie.gamesPlayed != null ? "confirmed" : "probable",
            source: "nhl_api",
          });
        }
        if (away_goalie?.firstName?.default) {
          starters.push({
            game: gameLabel,
            game_id: g.id,
            team: away,
            player: `${away_goalie.firstName.default} ${away_goalie.lastName?.default ?? ""}`.trim(),
            status: away_goalie.gamesPlayed != null ? "confirmed" : "probable",
            source: "nhl_api",
          });
        }
      } catch {
        // right-rail not always available before puck drop; skip silently
      }
    }
  } catch (err) {
    notes.push(`NHL probables fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { sport: "nhl", date, starters, notes };
}
