/**
 * Alternate Lines Value Scanner.
 * Scans alternate spreads and totals for +EV opportunities
 * that the main lines might miss.
 */

import axios from "axios";
import DecimalLib from "decimal.js";
const Decimal = DecimalLib.default ?? DecimalLib;
import { resolveSportKey, americanToImpliedProb, americanToDecimal, formatApiError } from "../../utils/helpers.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface AltLineValue {
  game: string;
  sport: string;
  market: string; // "alternate_spreads" | "alternate_totals"
  side: string;
  line: number;
  book: string;
  odds: number; // American
  pinnacle_equiv_odds: number | null;
  ev_percentage: number;
  implied_prob_pct: number;
  recommendation: string;
}

export interface AltLineScanResult {
  sport: string;
  scanned_games: number;
  value_plays: AltLineValue[];
  scan_time: string;
}

// ── Implementation ───────────────────────────────────────────────────────────

export async function scanAlternateLines(params: {
  sport: string;
  market?: string; // "spreads" | "totals" | "both"
  min_ev?: number; // minimum EV% to include (default 3)
}): Promise<AltLineScanResult> {
  const sportKey = resolveSportKey(params.sport);
  const minEv = params.min_ev ?? 3;
  const markets: string[] = [];

  if (!params.market || params.market === "both") {
    markets.push("alternate_spreads", "alternate_totals");
  } else if (params.market === "spreads") {
    markets.push("alternate_spreads");
  } else if (params.market === "totals") {
    markets.push("alternate_totals");
  }

  const apiKey = process.env.THE_ODDS_API_KEY;
  if (!apiKey) {
    return {
      sport: params.sport,
      scanned_games: 0,
      value_plays: [],
      scan_time: new Date().toISOString(),
    };
  }

  const valuePlays: AltLineValue[] = [];
  let scannedGames = 0;

  try {
    // Fetch events
    const eventsResp = await axios.get(
      `https://api.the-odds-api.com/v4/sports/${sportKey}/events`,
      { params: { apiKey }, timeout: 15000 }
    );
    const events = eventsResp.data ?? [];

    // Scan each event for alternate lines (limit to 5 events to conserve quota)
    for (const event of events.slice(0, 5)) {
      scannedGames++;
      const eventId = event.id as string;
      const gameName = `${event.away_team} @ ${event.home_team}`;

      for (const market of markets) {
        try {
          const oddsResp = await axios.get(
            `https://api.the-odds-api.com/v4/sports/${sportKey}/events/${eventId}/odds`,
            {
              params: {
                apiKey,
                regions: "us,us2,eu",
                markets: market,
                oddsFormat: "american",
              },
              timeout: 15000,
            }
          );

          const bookmakers = oddsResp.data?.bookmakers ?? [];

          // Collect all lines across books
          const linesByOutcome = new Map<string, { book: string; price: number; point: number; name: string }[]>();

          for (const bm of bookmakers) {
            for (const mkt of bm.markets ?? []) {
              for (const outcome of mkt.outcomes ?? []) {
                const key = `${outcome.name}_${outcome.point}`;
                if (!linesByOutcome.has(key)) linesByOutcome.set(key, []);
                linesByOutcome.get(key)!.push({
                  book: bm.key as string,
                  price: outcome.price as number,
                  point: outcome.point as number,
                  name: outcome.name as string,
                });
              }
            }
          }

          // Find value: compare each book's odds to the sharpest line (Pinnacle or consensus)
          for (const [, offerings] of linesByOutcome) {
            if (offerings.length < 2) continue;

            // Find Pinnacle line as benchmark, or use average
            const pinnacleOffer = offerings.find((o) => o.book === "pinnacle");
            const benchmarkOdds = pinnacleOffer
              ? pinnacleOffer.price
              : offerings.reduce((s, o) => s + o.price, 0) / offerings.length;

            const benchmarkProb = americanToImpliedProb(Math.round(benchmarkOdds));

            for (const offer of offerings) {
              if (offer.book === "pinnacle") continue; // Don't compare Pinnacle to itself

              const offerProb = americanToImpliedProb(offer.price);
              const offerDecimal = americanToDecimal(offer.price);

              // EV = (trueProb * decimalOdds) - 1
              // trueProb estimated from Pinnacle (with ~2% vig adjustment)
              const trueProb = benchmarkProb.times(0.975);
              const ev = trueProb.times(offerDecimal).minus(1).times(100);
              const evPct = ev.toDecimalPlaces(2).toNumber();

              if (evPct >= minEv) {
                valuePlays.push({
                  game: gameName,
                  sport: params.sport,
                  market,
                  side: offer.name,
                  line: offer.point,
                  book: offer.book,
                  odds: offer.price,
                  pinnacle_equiv_odds: pinnacleOffer ? pinnacleOffer.price : null,
                  ev_percentage: evPct,
                  implied_prob_pct: offerProb.times(100).toDecimalPlaces(2).toNumber(),
                  recommendation: evPct >= 8
                    ? "Strong value — significant edge over sharp benchmark"
                    : evPct >= 5
                    ? "Good value — moderate edge worth considering"
                    : "Marginal value — small edge, consider with other factors",
                });
              }
            }
          }

          await new Promise((r) => setTimeout(r, 1500)); // Rate limit
        } catch (err) {
          console.error(`[AltLines] ${gameName} ${market} failed:`, formatApiError(err, "The Odds API"));
        }
      }
    }
  } catch (error) {
    console.error("[AltLines] Scan failed:", formatApiError(error, "The Odds API"));
  }

  // Sort by EV descending
  valuePlays.sort((a, b) => b.ev_percentage - a.ev_percentage);

  return {
    sport: params.sport,
    scanned_games: scannedGames,
    value_plays: valuePlays.slice(0, 20),
    scan_time: new Date().toISOString(),
  };
}
