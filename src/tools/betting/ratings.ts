/**
 * Power Ratings / Elo Model
 * Maintains simple Elo ratings from game results stored in Postgres.
 * Provides an independent "fair line" to compare against market odds.
 * If no DB, returns league-average defaults.
 */

import { isDatabaseConfigured, query, queryOne } from "../../db/client.js";
import DecimalLib from "decimal.js";
const Decimal = DecimalLib.default ?? DecimalLib;

// ── Types ────────────────────────────────────────────────────────────────────

interface TeamRating {
  team: string;
  sport: string;
  elo: number;
  games_played: number;
  wins: number;
  losses: number;
  last_updated: string;
}

interface MatchupPrediction {
  home_team: string;
  away_team: string;
  home_elo: number;
  away_elo: number;
  home_win_prob: number;
  away_win_prob: number;
  fair_home_ml: number; // American odds
  fair_away_ml: number;
  elo_edge_home: number; // elo difference
  home_field_advantage: number;
  recommendation: string;
}

interface RatingsResult {
  sport: string;
  ratings?: TeamRating[];
  matchup?: MatchupPrediction;
  message: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_ELO = 1500;
const K_FACTOR: Record<string, number> = {
  nfl: 20,
  nba: 15,
  mlb: 8,
  nhl: 12,
  ncaaf: 25,
  ncaab: 20,
};
const HOME_ADVANTAGE: Record<string, number> = {
  nfl: 48, // ~2.5 points
  nba: 75, // ~3.5 points
  mlb: 24, // ~1 point
  nhl: 33, // ~1.5 points
  ncaaf: 55,
  ncaab: 65,
};

// ── Implementation ───────────────────────────────────────────────────────────

export async function getPowerRatings(params: {
  sport: string;
  home_team?: string;
  away_team?: string;
  action?: string; // "ratings" | "matchup" | "record_result"
  winner?: string;
  loser?: string;
  home_score?: number;
  away_score?: number;
}): Promise<RatingsResult> {
  const sport = params.sport.toLowerCase().trim();
  const action = params.action ?? (params.home_team && params.away_team ? "matchup" : "ratings");

  if (action === "record_result") {
    return recordGameResult(sport, params);
  }

  if (action === "matchup" && params.home_team && params.away_team) {
    return getMatchupPrediction(sport, params.home_team, params.away_team);
  }

  return getTeamRatings(sport);
}

// ── Get all ratings for a sport ──────────────────────────────────────────────

async function getTeamRatings(sport: string): Promise<RatingsResult> {
  if (!isDatabaseConfigured()) {
    return {
      sport,
      message:
        "Database not configured. Elo ratings require DATABASE_URL. " +
        "All teams default to 1500. Record game results to build ratings.",
    };
  }

  const rows = await query<TeamRating>(
    `SELECT team, sport, elo, games_played, wins, losses, last_updated::text
     FROM elo_ratings
     WHERE sport = $1
     ORDER BY elo DESC`,
    [sport]
  );

  if (rows.length === 0) {
    return {
      sport,
      ratings: [],
      message: `No ratings yet for ${sport}. Use action "record_result" to log game outcomes and build Elo ratings.`,
    };
  }

  return {
    sport,
    ratings: rows,
    message: `${rows.length} team ratings for ${sport}. Top: ${rows[0].team} (${rows[0].elo}), Bottom: ${rows[rows.length - 1].team} (${rows[rows.length - 1].elo}).`,
  };
}

// ── Matchup prediction ───────────────────────────────────────────────────────

async function getMatchupPrediction(
  sport: string,
  homeTeam: string,
  awayTeam: string
): Promise<RatingsResult> {
  let homeElo = DEFAULT_ELO;
  let awayElo = DEFAULT_ELO;

  if (isDatabaseConfigured()) {
    const homeRow = await queryOne<{ elo: number }>(
      `SELECT elo FROM elo_ratings WHERE sport = $1 AND LOWER(team) LIKE $2`,
      [sport, `%${homeTeam.toLowerCase()}%`]
    );
    const awayRow = await queryOne<{ elo: number }>(
      `SELECT elo FROM elo_ratings WHERE sport = $1 AND LOWER(team) LIKE $2`,
      [sport, `%${awayTeam.toLowerCase()}%`]
    );
    if (homeRow) homeElo = homeRow.elo;
    if (awayRow) awayElo = awayRow.elo;
  }

  const hfa = HOME_ADVANTAGE[sport] ?? 50;
  const homeAdj = homeElo + hfa;
  const eloDiff = homeAdj - awayElo;

  // Elo expected score: E = 1 / (1 + 10^(-diff/400))
  const homeWinProb = new Decimal(1).div(
    new Decimal(1).plus(new Decimal(10).pow(new Decimal(-eloDiff).div(400)))
  );
  const awayWinProb = new Decimal(1).minus(homeWinProb);

  const homeWinPct = homeWinProb.times(100).toDecimalPlaces(1).toNumber();
  const awayWinPct = awayWinProb.times(100).toDecimalPlaces(1).toNumber();

  // Convert to American odds
  const fairHomeMl = probToAmerican(homeWinProb.toNumber());
  const fairAwayMl = probToAmerican(awayWinProb.toNumber());

  let recommendation: string;
  if (Math.abs(eloDiff) < 30) {
    recommendation = `Very close matchup (Elo diff: ${eloDiff > 0 ? "+" : ""}${eloDiff}). Look for value on either side.`;
  } else if (eloDiff > 100) {
    recommendation = `Strong home edge (Elo diff: +${eloDiff}). Fair line ~${fairHomeMl > 0 ? "+" : ""}${fairHomeMl}. Compare against market — if market is wider, bet away.`;
  } else if (eloDiff < -100) {
    recommendation = `Strong away edge (Elo diff: ${eloDiff}). Fair line ~${fairAwayMl > 0 ? "+" : ""}${fairAwayMl}. Compare against market — if market is wider, bet home.`;
  } else {
    recommendation = `Moderate edge (Elo diff: ${eloDiff > 0 ? "+" : ""}${eloDiff}). Use as second opinion alongside Pinnacle line.`;
  }

  return {
    sport,
    matchup: {
      home_team: homeTeam,
      away_team: awayTeam,
      home_elo: homeElo,
      away_elo: awayElo,
      home_win_prob: homeWinPct,
      away_win_prob: awayWinPct,
      fair_home_ml: fairHomeMl,
      fair_away_ml: fairAwayMl,
      elo_edge_home: eloDiff,
      home_field_advantage: hfa,
      recommendation,
    },
    message: `${homeTeam} (${homeElo}) vs ${awayTeam} (${awayElo}). With HFA (+${hfa}): ${homeTeam} ${homeWinPct}% / ${awayTeam} ${awayWinPct}%.`,
  };
}

// ── Record a game result and update Elo ──────────────────────────────────────

async function recordGameResult(
  sport: string,
  params: {
    winner?: string;
    loser?: string;
    home_team?: string;
    away_team?: string;
    home_score?: number;
    away_score?: number;
  }
): Promise<RatingsResult> {
  if (!isDatabaseConfigured()) {
    return {
      sport,
      message: "Database not configured. Cannot record results without DATABASE_URL.",
    };
  }

  const winner = params.winner ?? params.home_team;
  const loser = params.loser ?? params.away_team;
  if (!winner || !loser) {
    throw new Error("Must provide winner/loser or home_team/away_team with scores.");
  }

  const k = K_FACTOR[sport] ?? 15;

  // Get or create ratings
  const winnerRow = await getOrCreateRating(sport, winner);
  const loserRow = await getOrCreateRating(sport, loser);

  // Calculate expected scores
  const diff = winnerRow.elo - loserRow.elo;
  const expectedWinner = 1 / (1 + Math.pow(10, -diff / 400));

  // Margin of victory multiplier (if scores provided)
  let movMultiplier = 1;
  if (params.home_score !== undefined && params.away_score !== undefined) {
    const margin = Math.abs(params.home_score - params.away_score);
    movMultiplier = Math.log(Math.max(margin, 1) + 1) * 0.7 + 0.6;
  }

  // Update Elo
  const winnerChange = Math.round(k * movMultiplier * (1 - expectedWinner));
  const newWinnerElo = winnerRow.elo + winnerChange;
  const newLoserElo = loserRow.elo - winnerChange;

  await query(
    `UPDATE elo_ratings SET elo = $1, games_played = games_played + 1, wins = wins + 1, last_updated = NOW()
     WHERE sport = $2 AND team = $3`,
    [newWinnerElo, sport, winner]
  );
  await query(
    `UPDATE elo_ratings SET elo = $1, games_played = games_played + 1, losses = losses + 1, last_updated = NOW()
     WHERE sport = $2 AND team = $3`,
    [newLoserElo, sport, loser]
  );

  return {
    sport,
    message: `Updated: ${winner} ${winnerRow.elo} → ${newWinnerElo} (+${winnerChange}), ${loser} ${loserRow.elo} → ${newLoserElo} (-${winnerChange}).`,
  };
}

async function getOrCreateRating(
  sport: string,
  team: string
): Promise<{ elo: number }> {
  const row = await queryOne<{ elo: number }>(
    `SELECT elo FROM elo_ratings WHERE sport = $1 AND team = $2`,
    [sport, team]
  );
  if (row) return row;

  await query(
    `INSERT INTO elo_ratings (sport, team, elo, games_played, wins, losses) VALUES ($1, $2, $3, 0, 0, 0)`,
    [sport, team, DEFAULT_ELO]
  );
  return { elo: DEFAULT_ELO };
}

// ── Utility ──────────────────────────────────────────────────────────────────

function probToAmerican(prob: number): number {
  if (prob >= 0.5) {
    return Math.round((-100 * prob) / (1 - prob));
  }
  return Math.round((100 * (1 - prob)) / prob);
}
