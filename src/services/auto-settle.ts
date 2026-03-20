/**
 * Auto-Settle Service
 * Pulls final scores from free APIs and settles pending bets automatically.
 * Also fixes CLV capture for bets missing game_date.
 *
 * Runs every 10 minutes via background services.
 */

import axios from "axios";
import { query, isDatabaseConfigured } from "../db/client.js";
import { getLiveOdds, GameOdds } from "../tools/betting/odds.js";
import { americanToImpliedProb } from "../utils/helpers.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface GameScore {
  home_team: string;
  away_team: string;
  home_score: number;
  away_score: number;
  status: "final" | "in_progress" | "scheduled";
  game_date: string;
}

// ── Main Entry Point ─────────────────────────────────────────────────────────

export async function runAutoSettle(): Promise<void> {
  if (!isDatabaseConfigured()) return;

  try {
    // Find all unsettled bets
    const pendingBets = (await query(
      `SELECT id, sport, game, side, odds, stake, bet_type, market, line, game_date, created_at
       FROM bets
       WHERE outcome IS NULL
       ORDER BY created_at DESC
       LIMIT 100`
    )) as Record<string, unknown>[];

    if (!pendingBets || pendingBets.length === 0) return;

    console.error(`[AutoSettle] Found ${pendingBets.length} unsettled bets`);

    // Group bets by sport to batch API calls
    const betsBySport = new Map<string, Record<string, unknown>[]>();
    for (const bet of pendingBets) {
      const sport = String(bet.sport);
      if (!betsBySport.has(sport)) betsBySport.set(sport, []);
      betsBySport.get(sport)!.push(bet);
    }

    // Fetch scores for each sport
    for (const [sport, bets] of betsBySport) {
      try {
        const scores = await fetchScores(sport);
        if (scores.length === 0) continue;

        for (const bet of bets) {
          try {
            await settleBet(bet, scores);
          } catch (err) {
            console.error(`[AutoSettle] Error settling bet #${bet.id}:`, err);
          }
        }
      } catch (err) {
        console.error(`[AutoSettle] Error fetching ${sport} scores:`, err);
      }
    }
  } catch (error) {
    console.error("[AutoSettle] Cycle error:", error);
  }
}

/**
 * Enhanced CLV capture that works even without game_date.
 * Matches bets to games by team name in the game description.
 */
export async function runEnhancedClvCapture(): Promise<void> {
  if (!isDatabaseConfigured()) return;

  try {
    // Find bets with no closing line that were created in the last 24 hours
    const bets = (await query(
      `SELECT id, sport, game, side, market, odds
       FROM bets
       WHERE closing_line IS NULL
         AND outcome IS NULL
         AND created_at >= NOW() - INTERVAL '24 hours'
       LIMIT 50`
    )) as Record<string, unknown>[];

    if (!bets || bets.length === 0) return;

    console.error(`[CLVCapture+] Found ${bets.length} bets needing closing lines`);

    // Group by sport to batch API calls
    const betsBySport = new Map<string, Record<string, unknown>[]>();
    for (const bet of bets) {
      const sport = String(bet.sport);
      if (!betsBySport.has(sport)) betsBySport.set(sport, []);
      betsBySport.get(sport)!.push(bet);
    }

    for (const [sport, sportBets] of betsBySport) {
      try {
        const games: GameOdds[] = await getLiveOdds({ sport, market: "h2h" });

        for (const bet of sportBets) {
          const betGame = String(bet.game ?? "").toLowerCase();
          const betSide = String(bet.side ?? "").toLowerCase();

          // Match game by team name
          const match = games.find(
            (g) =>
              betGame.includes(g.home_team.toLowerCase()) ||
              betGame.includes(g.away_team.toLowerCase())
          );

          if (!match) continue;

          // Check if this game has started or is about to start
          const commence = (match as unknown as Record<string, unknown>).commence_time as string | undefined;
          if (commence) {
            const gameTime = new Date(commence).getTime();
            const now = Date.now();
            // Only capture CLV within 15 minutes of game start
            if (gameTime - now > 15 * 60 * 1000) continue;
          }

          const pinnacle = match.pinnacle_line;
          if (!pinnacle) continue;

          // Find matching outcome
          const outcome = pinnacle.outcomes.find((o) =>
            betSide.includes(o.name.toLowerCase())
          );
          if (!outcome) continue;

          const closingLine = outcome.price;
          const openProb = americanToImpliedProb(Number(bet.odds));
          const closeProb = americanToImpliedProb(closingLine);
          const clv = closeProb.minus(openProb).times(100).toDecimalPlaces(3).toNumber();

          await query(
            `UPDATE bets SET closing_line = $1, clv = $2 WHERE id = $3`,
            [closingLine, clv, bet.id]
          );

          console.error(
            `[CLVCapture+] Bet #${bet.id}: closing=${closingLine}, CLV=${clv.toFixed(2)}%`
          );
        }

        await sleep(2000);
      } catch (err) {
        console.error(`[CLVCapture+] ${sport} failed:`, err);
      }
    }
  } catch (error) {
    console.error("[CLVCapture+] Cycle error:", error);
  }
}

// ── Score Fetching ───────────────────────────────────────────────────────────

async function fetchScores(sport: string): Promise<GameScore[]> {
  const scores: GameScore[] = [];
  const today = new Date().toISOString().slice(0, 10);

  try {
    switch (sport.toLowerCase()) {
      case "nba": {
        // BallDontLie API (free)
        const key = process.env.BALLDONTLIE_API_KEY;
        const headers: Record<string, string> = {};
        if (key) headers["Authorization"] = key;

        const resp = await axios.get(
          `https://api.balldontlie.io/v1/games?dates[]=${today}`,
          { headers, timeout: 10000 }
        );
        for (const g of resp.data?.data ?? []) {
          if (g.status === "Final") {
            scores.push({
              home_team: g.home_team?.full_name ?? g.home_team?.name ?? "",
              away_team: g.visitor_team?.full_name ?? g.visitor_team?.name ?? "",
              home_score: g.home_team_score ?? 0,
              away_score: g.visitor_team_score ?? 0,
              status: "final",
              game_date: today,
            });
          }
        }
        break;
      }

      case "nhl": {
        // NHL API (free, no key needed)
        const resp = await axios.get(
          `https://api-web.nhle.com/v1/score/${today}`,
          { timeout: 10000 }
        );
        for (const g of resp.data?.games ?? []) {
          if (g.gameState === "OFF" || g.gameState === "FINAL") {
            scores.push({
              home_team: g.homeTeam?.name?.default ?? "",
              away_team: g.awayTeam?.name?.default ?? "",
              home_score: g.homeTeam?.score ?? 0,
              away_score: g.awayTeam?.score ?? 0,
              status: "final",
              game_date: today,
            });
          }
        }
        break;
      }

      case "mlb": {
        // MLB StatsAPI (free, no key needed)
        const resp = await axios.get(
          `https://statsapi.mlb.com/api/v1/schedule?date=${today}&sportId=1&hydrate=linescore`,
          { timeout: 10000 }
        );
        for (const date of resp.data?.dates ?? []) {
          for (const g of date.games ?? []) {
            if (g.status?.detailedState === "Final") {
              scores.push({
                home_team: g.teams?.home?.team?.name ?? "",
                away_team: g.teams?.away?.team?.name ?? "",
                home_score: g.teams?.home?.score ?? 0,
                away_score: g.teams?.away?.score ?? 0,
                status: "final",
                game_date: today,
              });
            }
          }
        }
        break;
      }

      case "ncaab":
      case "ncaaf": {
        // ESPN API (free, no key needed)
        const espnSport = sport === "ncaab" ? "basketball/mens-college-basketball" : "football/college-football";
        const resp = await axios.get(
          `https://site.api.espn.com/apis/site/v2/sports/${espnSport}/scoreboard`,
          { timeout: 10000 }
        );
        for (const event of resp.data?.events ?? []) {
          const comp = event.competitions?.[0];
          if (!comp) continue;
          const statusType = comp.status?.type?.name;
          if (statusType !== "STATUS_FINAL") continue;

          const teams = comp.competitors ?? [];
          const home = teams.find((t: Record<string, unknown>) => t.homeAway === "home");
          const away = teams.find((t: Record<string, unknown>) => t.homeAway === "away");

          scores.push({
            home_team: (home?.team as Record<string, unknown>)?.displayName as string ?? "",
            away_team: (away?.team as Record<string, unknown>)?.displayName as string ?? "",
            home_score: Number(home?.score ?? 0),
            away_score: Number(away?.score ?? 0),
            status: "final",
            game_date: today,
          });
        }
        break;
      }
    }
  } catch (err) {
    console.error(`[AutoSettle] Score fetch for ${sport} failed:`, err);
  }

  return scores;
}

// ── Bet Settlement Logic ─────────────────────────────────────────────────────

async function settleBet(
  bet: Record<string, unknown>,
  scores: GameScore[]
): Promise<void> {
  const betGame = String(bet.game ?? "").toLowerCase();
  const betSide = String(bet.side ?? "").toLowerCase();
  const betType = String(bet.bet_type ?? "").toLowerCase();
  const betOdds = Number(bet.odds);
  const betStake = Number(bet.stake);
  const betLine = bet.line != null ? Number(bet.line) : null;

  // Find matching game from scores
  const match = scores.find(
    (s) =>
      s.status === "final" &&
      (betGame.includes(s.home_team.toLowerCase()) ||
        betGame.includes(s.away_team.toLowerCase()) ||
        s.home_team.toLowerCase().split(" ").some((w) => betGame.includes(w)) ||
        s.away_team.toLowerCase().split(" ").some((w) => betGame.includes(w)))
  );

  if (!match) return; // Game hasn't finished yet

  const totalScore = match.home_score + match.away_score;
  const homeMargin = match.home_score - match.away_score;

  let outcome: "win" | "loss" | "push" | null = null;
  let payout = 0;

  // Skip parlays — too complex to auto-settle without leg-level data
  if (betType === "parlay") {
    console.error(`[AutoSettle] Skipping parlay bet #${bet.id} — requires manual settlement`);
    return;
  }

  // Determine outcome based on bet type
  if (betType === "h2h" || betType === "moneyline" || betSide.includes("ml")) {
    // Moneyline: did the team win?
    const betOnHome = betSide.includes(match.home_team.toLowerCase()) ||
      match.home_team.toLowerCase().split(" ").some((w) => w.length > 3 && betSide.includes(w));
    const betOnAway = betSide.includes(match.away_team.toLowerCase()) ||
      match.away_team.toLowerCase().split(" ").some((w) => w.length > 3 && betSide.includes(w));

    if (betOnHome) {
      outcome = homeMargin > 0 ? "win" : homeMargin < 0 ? "loss" : "push";
    } else if (betOnAway) {
      outcome = homeMargin < 0 ? "win" : homeMargin > 0 ? "loss" : "push";
    }
  } else if (betType === "spread" && betLine != null) {
    // Spread: team score + spread vs opponent
    const betOnHome = betSide.includes(match.home_team.toLowerCase()) ||
      match.home_team.toLowerCase().split(" ").some((w) => w.length > 3 && betSide.includes(w));

    if (betOnHome) {
      const adjustedMargin = homeMargin + betLine;
      outcome = adjustedMargin > 0 ? "win" : adjustedMargin < 0 ? "loss" : "push";
    } else {
      // Away team spread: flip perspective
      const awayMargin = -homeMargin + betLine;
      outcome = awayMargin > 0 ? "win" : awayMargin < 0 ? "loss" : "push";
    }
  } else if (betType === "total" && betLine != null) {
    // Total: over/under
    const isOver = betSide.includes("over");
    const isUnder = betSide.includes("under");

    if (isOver) {
      outcome = totalScore > betLine ? "win" : totalScore < betLine ? "loss" : "push";
    } else if (isUnder) {
      outcome = totalScore < betLine ? "win" : totalScore > betLine ? "loss" : "push";
    }
  }

  if (!outcome) return; // Couldn't determine outcome

  // Calculate payout
  if (outcome === "win") {
    if (betOdds > 0) {
      payout = betStake + betStake * (betOdds / 100);
    } else {
      payout = betStake + betStake * (100 / Math.abs(betOdds));
    }
  } else if (outcome === "push") {
    payout = betStake;
  } else {
    payout = 0;
  }

  payout = Math.round(payout * 100) / 100;

  // Update the bet
  await query(
    `UPDATE bets SET outcome = $1, payout = $2 WHERE id = $3 AND outcome IS NULL`,
    [outcome, payout, bet.id]
  );

  console.error(
    `[AutoSettle] Bet #${bet.id}: ${betSide} → ${outcome.toUpperCase()} | ` +
    `Score: ${match.away_team} ${match.away_score} - ${match.home_team} ${match.home_score} | ` +
    `Payout: $${payout.toFixed(2)}`
  );
}

// ── Util ─────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
