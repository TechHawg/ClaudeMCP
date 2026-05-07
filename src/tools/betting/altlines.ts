/**
 * Alternate Lines Value Scanner.
 * Scans alternate spreads and totals for +EV opportunities
 * that the main lines might miss.
 */

import axios from "axios";
import {
  resolveSportKey,
  americanToImpliedProb,
  americanToDecimal,
  multiBookConsensusNoVig,
  trueEvPercent,
  formatApiError,
  type DataQuality,
} from "../../utils/helpers.js";

const SHARP_BOOKS = new Set([
  "pinnacle",
  "circasports",
  "circa",
  "bookmaker_eu",
  "bookmaker.eu",
  "betcris",
  "matchbook",
]);

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
  fair_prob_pct: number;
  fair_source: string;
  fair_sample_size: number;
  ev_percentage: number;
  no_vig_edge_pct: number;
  implied_prob_pct: number;
  data_quality: DataQuality;
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

          // Build per-(name, point) groups across books, capturing both
          // the target side and its opposing side at the same book/point.
          // This enables proper per-book de-vig instead of using raw juiced
          // implied probabilities.
          interface Offer { book: string; price: number; point: number; name: string; opposingPrice?: number }
          const groupsByLine = new Map<string, Offer[]>();

          for (const bm of bookmakers) {
            for (const mkt of bm.markets ?? []) {
              const outcomes = (mkt.outcomes ?? []) as { name: string; point: number; price: number }[];
              for (const outcome of outcomes) {
                // Find opposing side at this book at the matching point.
                // Spreads/totals: same point, opposite side. Totals have
                // Over/Under strings. Spreads use point sign.
                const opposing = outcomes.find((o) => {
                  if (o.name === outcome.name) return false;
                  if (market === "alternate_totals") {
                    return Math.abs((o.point ?? 0) - (outcome.point ?? 0)) < 0.01;
                  }
                  if (market === "alternate_spreads") {
                    return Math.abs((o.point ?? 0) + (outcome.point ?? 0)) < 0.01;
                  }
                  return false;
                });

                const key = `${outcome.name}_${outcome.point}`;
                if (!groupsByLine.has(key)) groupsByLine.set(key, []);
                groupsByLine.get(key)!.push({
                  book: bm.key as string,
                  price: outcome.price,
                  point: outcome.point,
                  name: outcome.name,
                  opposingPrice: opposing?.price,
                });
              }
            }
          }

          for (const [, offerings] of groupsByLine) {
            if (offerings.length < 2) continue;

            // Build sharp consensus from Pinnacle/Circa/Bookmaker.eu/etc.
            const sharpPairs = offerings
              .filter((o) => SHARP_BOOKS.has(o.book.toLowerCase()) && o.opposingPrice != null)
              .map((o) => ({
                priceA: o.price,
                priceB: o.opposingPrice!,
                book: o.book,
              }));

            const consensus = multiBookConsensusNoVig(sharpPairs);
            if (!consensus) continue; // Can't de-vig without opposing odds

            const fairProb = consensus.medianProbA;
            const pinnacleOffer = offerings.find((o) => o.book === "pinnacle");

            for (const offer of offerings) {
              if (SHARP_BOOKS.has(offer.book.toLowerCase())) continue;

              const offerProb = americanToImpliedProb(offer.price);
              const evPct = trueEvPercent(fairProb, offer.price);
              const edgePct = fairProb.minus(offerProb).times(100).toNumber();

              if (evPct < minEv) continue;

              valuePlays.push({
                game: gameName,
                sport: params.sport,
                market,
                side: offer.name,
                line: offer.point,
                book: offer.book,
                odds: offer.price,
                pinnacle_equiv_odds: pinnacleOffer ? pinnacleOffer.price : null,
                fair_prob_pct: fairProb.times(100).toDecimalPlaces(2).toNumber(),
                fair_source: consensus.sampleSize > 1 ? "multi_book_consensus" : "single_sharp_book",
                fair_sample_size: consensus.sampleSize,
                ev_percentage: evPct,
                no_vig_edge_pct: Number(edgePct.toFixed(3)),
                implied_prob_pct: offerProb.times(100).toDecimalPlaces(2).toNumber(),
                data_quality: "real",
                recommendation:
                  evPct >= 8
                    ? "Strong no-vig edge — sharp consensus disagrees materially with this book."
                    : evPct >= 5
                      ? "Good no-vig edge — worth a small position."
                      : "Marginal edge — only play if other signals confirm.",
              });
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
