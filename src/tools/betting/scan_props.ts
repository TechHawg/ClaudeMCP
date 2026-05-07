/**
 * Batched player-prop edge scanner.
 *
 * Walks events for a sport, fetches all bookmakers' offers for the chosen prop
 * markets, groups by (player, line) across books, computes multi-book sharp-book
 * consensus no-vig fair probability, and surfaces plays where the best-available
 * book price has > minEdge no-vig edge.
 *
 * This is the prop equivalent of `findValueLines` for h2h/spreads/totals — and
 * is what makes prop scans feasible inside `screen_plays` without per-player
 * lookups blowing up the quota.
 */

import axios from "axios";
import {
  resolveSportKey,
  multiBookConsensusNoVig,
  americanToImpliedProb,
  trueEvPercent,
  type DataQuality,
} from "../../utils/helpers.js";
import { isDatabaseConfigured, query } from "../../db/client.js";

const SHARP_PROP_BOOKS = new Set([
  "pinnacle",
  "circasports",
  "circa",
  "bookmaker_eu",
  "bookmaker.eu",
  "betcris",
  "matchbook",
]);

// Prop markets we scan per sport. The Odds API requires the keys to be passed
// individually; each market is a separate billable call per event, so keep the
// list tight and skip events when quota matters.
const DEFAULT_MARKETS_BY_SPORT: Record<string, string[]> = {
  basketball_nba: ["player_points", "player_rebounds", "player_assists", "player_threes"],
  basketball_ncaab: ["player_points", "player_rebounds", "player_assists"],
  baseball_mlb: ["batter_hits", "batter_total_bases", "batter_home_runs", "pitcher_strikeouts"],
  americanfootball_nfl: ["player_pass_yds", "player_rush_yds", "player_reception_yds", "player_receptions"],
  americanfootball_ncaaf: ["player_pass_yds", "player_rush_yds", "player_reception_yds"],
  icehockey_nhl: ["player_points", "player_shots_on_goal", "player_total_saves"],
};

export interface PropEdgePlay {
  game: string;
  sport: string;
  market: string;
  player: string;
  line: number;
  side: "over" | "under";
  best_book: string;
  best_price: number;
  fair_prob_pct: number;
  no_vig_edge_pct: number;
  ev_percentage: number;
  fair_source: "multi_book_consensus" | "single_sharp_book";
  fair_books: string[];
  fair_sample_size: number;
  data_quality: DataQuality;
  /** Hit rate vs current line from prop_hit_rates if available. */
  historical_hit_rate_pct?: number;
  hit_rate_sample_size?: number;
  hit_rate_data_quality?: "real" | "inferred" | "missing";
  all_book_offers: Array<{ book: string; over: number; under?: number }>;
}

export interface ScanPropsResult {
  sport: string;
  events_scanned: number;
  markets_scanned: string[];
  plays: PropEdgePlay[];
  notes: string[];
}

export async function scanProps(params: {
  sport: string;
  markets?: string[];
  /** Min no-vig edge in pct points to include (default 2). Props are noisier so we use a higher floor than h2h. */
  min_edge_pct?: number;
  /** Max events to scan to conserve API quota (default 8). */
  max_events?: number;
  /** If true (default) and prop_hit_rates has data, attach hit rates per play. */
  include_hit_rate?: boolean;
}): Promise<ScanPropsResult> {
  const sportKey = resolveSportKey(params.sport);
  const minEdge = params.min_edge_pct ?? 2;
  const maxEvents = params.max_events ?? 8;
  const markets = params.markets ?? DEFAULT_MARKETS_BY_SPORT[sportKey] ?? [];
  const includeHitRate = params.include_hit_rate ?? true;
  const notes: string[] = [];

  const apiKey = process.env.THE_ODDS_API_KEY;
  if (!apiKey) {
    return { sport: params.sport, events_scanned: 0, markets_scanned: markets, plays: [], notes: ["THE_ODDS_API_KEY not set."] };
  }
  if (markets.length === 0) {
    notes.push(`No default prop markets for sport ${sportKey}. Pass explicit markets.`);
    return { sport: params.sport, events_scanned: 0, markets_scanned: markets, plays: [], notes };
  }

  let events: { id: string; home_team: string; away_team: string }[] = [];
  try {
    const eventsResp = await axios.get(
      `https://api.the-odds-api.com/v4/sports/${sportKey}/events`,
      { params: { apiKey }, timeout: 15000 }
    );
    events = (eventsResp.data ?? []).slice(0, maxEvents);
  } catch (err) {
    notes.push(`Events fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    return { sport: params.sport, events_scanned: 0, markets_scanned: markets, plays: [], notes };
  }

  const allPlays: PropEdgePlay[] = [];

  for (const event of events) {
    const game = `${event.away_team} @ ${event.home_team}`;
    for (const market of markets) {
      try {
        const oddsResp = await axios.get(
          `https://api.the-odds-api.com/v4/sports/${sportKey}/events/${event.id}/odds`,
          { params: { apiKey, regions: "us,us2", markets: market, oddsFormat: "american" }, timeout: 15000 }
        );
        const bookmakers = oddsResp.data?.bookmakers ?? [];

        // Group by (player, line): { book → { over_price, under_price } }
        interface BookOffer { over: number; under?: number }
        const grouped = new Map<string, Map<string, BookOffer>>();

        for (const bm of bookmakers) {
          const book = String(bm.key).toLowerCase();
          for (const mkt of bm.markets ?? []) {
            for (const o of mkt.outcomes ?? []) {
              const player = String(o.description ?? "").trim();
              const point = Number(o.point);
              const price = Number(o.price);
              const sideName = String(o.name ?? "").toLowerCase();
              if (!player || !Number.isFinite(point) || !Number.isFinite(price)) continue;
              const key = `${player}|${point}`;
              if (!grouped.has(key)) grouped.set(key, new Map());
              const m = grouped.get(key)!;
              if (!m.has(book)) m.set(book, { over: 0 });
              const offer = m.get(book)!;
              if (sideName === "over") offer.over = price;
              else if (sideName === "under") offer.under = price;
            }
          }
        }

        // For each (player, line) compute consensus and edge per side.
        for (const [key, byBook] of grouped) {
          const [player, lineStr] = key.split("|");
          const line = Number(lineStr);
          const offers = [...byBook.entries()].map(([book, off]) => ({ book, ...off }));

          const sharpPairs = offers
            .filter((o) => SHARP_PROP_BOOKS.has(o.book) && o.under != null && o.over !== 0)
            .map((o) => ({ priceA: o.over, priceB: o.under as number, book: o.book }));
          if (sharpPairs.length === 0) continue;

          const consensus = multiBookConsensusNoVig(sharpPairs);
          if (!consensus) continue;
          const fairProbOver = consensus.medianProbA.toNumber();
          const fairProbUnder = 1 - fairProbOver;

          // Best OVER and best UNDER offers across ALL books
          const validOver = offers.filter((o) => o.over !== 0).sort((a, b) => b.over - a.over);
          const validUnder = offers.filter((o) => o.under != null).sort((a, b) => (b.under! - a.under!));

          for (const [side, bestOffer, fairProb] of [
            ["over", validOver[0], fairProbOver] as const,
            ["under", validUnder[0], fairProbUnder] as const,
          ]) {
            if (!bestOffer) continue;
            const price = side === "over" ? bestOffer.over : (bestOffer.under as number);
            const bookProb = americanToImpliedProb(price).toNumber();
            const edgePct = (fairProb - bookProb) * 100;
            if (edgePct < minEdge) continue;

            // Skip recommending sharp books to themselves
            if (SHARP_PROP_BOOKS.has(bestOffer.book)) continue;

            const evPct = trueEvPercent(fairProb, price);

            allPlays.push({
              game,
              sport: params.sport,
              market,
              player,
              line,
              side,
              best_book: bestOffer.book,
              best_price: price,
              fair_prob_pct: Number((fairProb * 100).toFixed(2)),
              no_vig_edge_pct: Number(edgePct.toFixed(3)),
              ev_percentage: evPct,
              fair_source: consensus.sampleSize > 1 ? "multi_book_consensus" : "single_sharp_book",
              fair_books: consensus.books,
              fair_sample_size: consensus.sampleSize,
              data_quality: "real",
              all_book_offers: offers.map((o) => ({ book: o.book, over: o.over, under: o.under })),
            });
          }
        }

        await sleep(800); // pace API
      } catch (err) {
        notes.push(`${game} ${market} skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Optionally enrich with historical hit rate
  if (includeHitRate && allPlays.length > 0 && isDatabaseConfigured()) {
    await enrichHitRates(allPlays);
  }

  allPlays.sort((a, b) => b.no_vig_edge_pct - a.no_vig_edge_pct);

  return {
    sport: params.sport,
    events_scanned: events.length,
    markets_scanned: markets,
    plays: allPlays.slice(0, 30),
    notes,
  };
}

async function enrichHitRates(plays: PropEdgePlay[]): Promise<void> {
  // Build distinct (player, sport, market, line) keys
  for (const p of plays) {
    try {
      const sportKey = p.sport.toLowerCase();
      const rows = await query<{ actual_value: string | number | null }>(
        `SELECT actual_value FROM prop_hit_rates
          WHERE player_name = $1 AND sport = $2 AND market = $3
            AND actual_value IS NOT NULL
            AND game_date >= CURRENT_DATE - INTERVAL '180 days'
          ORDER BY game_date DESC LIMIT 30`,
        [p.player, sportKey, p.market]
      );
      if (rows.length === 0) {
        p.historical_hit_rate_pct = undefined;
        p.hit_rate_sample_size = 0;
        p.hit_rate_data_quality = "missing";
        continue;
      }
      const overs = rows.filter((r) => Number(r.actual_value) > p.line).length;
      const total = rows.length;
      const overRate = (overs / total) * 100;
      const ratePct = p.side === "over" ? overRate : 100 - overRate;
      p.historical_hit_rate_pct = Number(ratePct.toFixed(1));
      p.hit_rate_sample_size = total;
      p.hit_rate_data_quality = total >= 10 ? "real" : "inferred";
    } catch (err) {
      console.error("[ScanProps] hit-rate enrichment failed:", err);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
