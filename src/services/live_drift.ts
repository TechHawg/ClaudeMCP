/**
 * Live in-play drift capture.
 *
 * For each bet flagged is_live=true, 60-180 seconds after placement we re-fetch
 * the live odds for that game/side and compute the no-vig prob shift. This is
 * the "live CLV" — were we early or late on the move?
 *
 * Runs every 60 seconds. Picks up live bets created in the 1-15 minute window
 * (so we don't capture too early or after the price has cycled multiple times).
 */

import { isDatabaseConfigured, query } from "../db/client.js";
import { getLiveInPlayOdds } from "../tools/betting/live.js";
import { noVigProb2Way, americanToImpliedProb } from "../utils/helpers.js";

export async function runLiveDriftCapture(): Promise<{ processed: number; updated: number }> {
  if (!isDatabaseConfigured()) return { processed: 0, updated: 0 };

  let processed = 0;
  let updated = 0;
  try {
    // Live bets in the 1-15 min window with no drift recorded yet.
    const rows = (await query(
      `SELECT id, sport, game, side, market, odds
         FROM bets
        WHERE is_live = true
          AND live_drift_pct IS NULL
          AND created_at > NOW() - INTERVAL '15 minutes'
          AND created_at < NOW() - INTERVAL '60 seconds'
        LIMIT 50`
    )) as Record<string, unknown>[];

    if (rows.length === 0) return { processed: 0, updated: 0 };

    // Group by sport so we make one live odds call per sport
    const bySport = new Map<string, Record<string, unknown>[]>();
    for (const r of rows) {
      const s = String(r.sport);
      if (!bySport.has(s)) bySport.set(s, []);
      bySport.get(s)!.push(r);
    }

    for (const [sport, sportBets] of bySport) {
      try {
        const live = (await getLiveInPlayOdds({ sport })) as { games?: Array<Record<string, unknown>> };
        const games = live.games ?? [];

        for (const bet of sportBets) {
          processed++;
          const betGame = String(bet.game ?? "").toLowerCase();
          const betSide = String(bet.side ?? "").toLowerCase();
          const market = String(bet.market ?? "h2h");
          const betOdds = Number(bet.odds);

          // Match game by team name token
          const gameMatch = games.find((g) => {
            const home = String(g.home_team ?? "").toLowerCase();
            const away = String(g.away_team ?? "").toLowerCase();
            return betGame.includes(home) || betGame.includes(away);
          });
          if (!gameMatch) continue;

          // Find Pinnacle outcome and the opposing one for de-vig
          const bookmakers = gameMatch.bookmakers as Array<Record<string, unknown>> | undefined;
          if (!bookmakers) continue;
          const pin = bookmakers.find((b) => String(b.bookmaker ?? b.key).toLowerCase() === "pinnacle");
          if (!pin) continue;
          const outcomes = (pin.outcomes as Array<Record<string, unknown>>) ?? [];
          const target = outcomes.find((o) => betSide.includes(String(o.name).toLowerCase()));
          const opposing = outcomes.find((o) => o !== target);
          if (!target || !opposing) continue;

          const livePrice = Number(target.price);
          const oppPrice = Number(opposing.price);
          if (!Number.isFinite(livePrice) || !Number.isFinite(oppPrice)) continue;

          // Compute drift in no-vig prob: live no-vig - bet-time approximation
          const liveNoVig = noVigProb2Way(livePrice, oppPrice).toNumber();
          const betNoVigApprox = americanToImpliedProb(betOdds).toNumber() / 1.0225; // half-vig haircut
          const driftPct = (liveNoVig - betNoVigApprox) * 100;

          await query(
            `UPDATE bets
                SET live_drift_pct = $1, live_drift_captured_at = NOW()
              WHERE id = $2`,
            [Number(driftPct.toFixed(3)), bet.id]
          );
          updated++;
        }
      } catch (err) {
        console.error(`[LiveDrift] sport ${sport} failed:`, err instanceof Error ? err.message : err);
      }
    }
  } catch (err) {
    console.error("[LiveDrift] cycle failed:", err);
  }

  return { processed, updated };
}
