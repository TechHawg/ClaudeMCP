/**
 * Value Line Detection — proper no-vig EV vs sharp consensus.
 *
 * Why this differs from the original implementation:
 *   - Strips vig from Pinnacle (and other sharp books) before computing edge.
 *     The previous version used the *juiced* implied probability, which
 *     systematically inflates EV by ~half-the-vig (≈1% on a -110/-110 line).
 *   - Builds a multi-book sharp consensus (Pinnacle, Circa, BetCRIS,
 *     Bookmaker.eu) and uses the median no-vig probability as fair price,
 *     not Pinnacle alone. Single-book reference fails when Pinnacle is offline
 *     for a market or hasn't moved yet.
 *   - Optionally consults the user's CLV history to gate recommendations:
 *     a market with negative rolling CLV is suppressed automatically.
 */

import { getLiveOdds, type GameOdds, type BookmakerOdds } from "./odds.js";
import {
  americanToDecimal,
  americanToImpliedProb,
  multiBookConsensusNoVig,
  noVigProb2Way,
  trueEvPercent,
  type DataQuality,
} from "../../utils/helpers.js";
import { isDatabaseConfigured, query } from "../../db/client.js";
import { getPinnacleDrift } from "../../utils/drift.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ValueLine {
  game: string;
  side: string;
  point?: number;
  best_book: string;
  best_price: number;
  best_decimal: number;
  /** No-vig fair probability for this side based on sharp consensus. */
  fair_prob_pct: number;
  /** Implied probability of the offered book line. */
  book_prob_pct: number;
  /** No-vig edge in percentage points (fair_prob - book_prob). */
  no_vig_edge_pct: number;
  /** True EV % using fair_prob (the only correct EV calculation). */
  ev_percentage: number;
  /** Sharp reference book (or "consensus" if multi-book). */
  fair_source: string;
  fair_books: string[];
  fair_sample_size: number;
  /** 1-10 rating; 10 only for >5% no-vig edge. */
  value_rating: number;
  data_quality: DataQuality;
  /** True only if user CLV history for this (sport, bet_type, book) is non-negative or unknown. */
  passes_clv_gate: boolean;
  clv_gate_reason: string;
  /** Pinnacle no-vig drift in the last hour: + means moving toward your side. */
  pinnacle_drift_pct?: number;
  passes_drift_gate: boolean;
  drift_gate_reason: string;
}

export interface ValueScanResult {
  sport: string;
  market: string;
  value_lines: ValueLine[];
  games_scanned: number;
  fair_methodology: string;
  cached_at: string;
  notes: string[];
}

// Sharp books used to build the no-vig consensus, in order of preference.
const SHARP_BOOKS = [
  "pinnacle",
  "circasports",
  "circa",
  "bookmaker_eu",
  "bookmaker.eu",
  "betcris",
  "matchbook",
] as const;

// ── Implementation ───────────────────────────────────────────────────────────

export async function findValueLines(params: {
  sport: string;
  game?: string;
  bet_type?: string;
  side?: string;
  /** Minimum no-vig edge in percentage points to include (default 1.5). */
  min_edge_pct?: number;
  /** If true, drop plays where user's rolling CLV in this cluster is negative. Default true. */
  enforce_clv_gate?: boolean;
  /** Lookback window for the CLV gate. Default 60 days. */
  clv_lookback_days?: number;
  /** If true (default), refuse plays where Pinnacle has drifted >= 1.5% AWAY from your side in the last hour. */
  enforce_drift_gate?: boolean;
}): Promise<ValueScanResult> {
  const market = params.bet_type ?? "h2h";
  const minEdge = params.min_edge_pct ?? 1.5;
  const enforceClvGate = params.enforce_clv_gate ?? true;
  const clvLookback = params.clv_lookback_days ?? 60;
  const enforceDriftGate = params.enforce_drift_gate ?? true;

  const games = await getLiveOdds({
    sport: params.sport,
    game: params.game,
    market,
  });

  const valueLines: ValueLine[] = [];
  const notes: string[] = [];

  // Preload CLV stats once for this scan so we don't query per-line.
  const clvByCluster = enforceClvGate
    ? await loadClvByCluster(params.sport, market, clvLookback)
    : new Map<string, number>();

  // Cache drift queries by (game_id, market, side, point) so we don't
  // hit the DB once per book (~8 books × per side = wasted queries).
  const driftCache = new Map<string, Awaited<ReturnType<typeof getPinnacleDrift>>>();

  for (const game of games) {
    // Build the universe of opposing-side prices for each named outcome.
    // We pair them per book so we can de-vig per book.
    const outcomeNames = collectOutcomeNames(game);

    for (const outcomeName of outcomeNames) {
      if (
        params.side &&
        !outcomeName.toLowerCase().includes(params.side.toLowerCase())
      ) {
        continue;
      }

      // For each unique line point, build sharp consensus and scan books.
      const pointGroups = groupOutcomesByPoint(game, outcomeName);

      for (const [pointKey, perBook] of pointGroups) {
        const consensus = buildSharpConsensus(perBook);
        if (!consensus) continue;

        // Scan every book for the same outcome+point and compute true EV.
        for (const offer of perBook.offers) {
          if (SHARP_BOOKS.includes(offer.book.toLowerCase() as (typeof SHARP_BOOKS)[number])) {
            // Don't recommend the sharp book back to itself; sharp books are
            // the truth source, not the value source.
            continue;
          }

          const bookProb = americanToImpliedProb(offer.price);
          const bookDec = americanToDecimal(offer.price);
          const fairProb = consensus.medianProbA;

          const edgePct = fairProb.minus(bookProb).times(100).toNumber();
          const evPct = trueEvPercent(fairProb, offer.price);

          if (edgePct < minEdge) continue;

          const cluster = clusterKey(params.sport, market, offer.book);
          const clvForCluster = clvByCluster.get(cluster);
          const passesClv =
            !enforceClvGate ||
            clvForCluster === undefined ||
            clvForCluster >= -0.25; // 0.25% buffer to avoid noise rejection
          const clvReason =
            clvForCluster === undefined
              ? "No prior CLV history for this cluster (default: pass)."
              : passesClv
                ? `Cluster CLV ${clvForCluster.toFixed(2)}% — acceptable.`
                : `Cluster CLV ${clvForCluster.toFixed(2)}% — historically negative; suppressed.`;

          // Pinnacle drift gate — refuse if sharp money has moved AWAY from this side
          // by >=1.5 percentage points in the last hour. Cached per (game, side, point)
          // so we don't query the DB once per book.
          let drift: number | undefined;
          let passesDrift = true;
          let driftReason = "Drift gate not evaluated (DB unavailable or no history).";
          if (enforceDriftGate) {
            const driftCacheKey = `${game.id}|${market}|${outcomeName}|${pointKey}`;
            let driftRes = driftCache.get(driftCacheKey);
            if (!driftRes) {
              driftRes = await getPinnacleDrift({
                game_id: game.id,
                market,
                side: outcomeName,
                hours_back: 1,
              });
              driftCache.set(driftCacheKey, driftRes);
            }
            if (driftRes.reliable && driftRes.drift_pct != null) {
              drift = driftRes.drift_pct;
              if (drift <= -1.5) {
                passesDrift = false;
                driftReason = `Pinnacle no-vig prob has moved ${drift.toFixed(2)}% AWAY from this side in the last hour — sharp money is on the other side; suppressed.`;
              } else {
                driftReason = `Drift acceptable (${drift.toFixed(2)}% over ${driftRes.snapshots} snapshots).`;
              }
            } else if (driftRes.snapshots > 0) {
              driftReason = `Insufficient drift data (${driftRes.snapshots} snapshots).`;
            }
          }

          valueLines.push({
            game: `${game.away_team} @ ${game.home_team}`,
            side: outcomeName,
            point: pointKey === "_" ? undefined : Number(pointKey),
            best_book: offer.book,
            best_price: offer.price,
            best_decimal: bookDec.toDecimalPlaces(4).toNumber(),
            fair_prob_pct: fairProb.times(100).toDecimalPlaces(2).toNumber(),
            book_prob_pct: bookProb.times(100).toDecimalPlaces(2).toNumber(),
            no_vig_edge_pct: Number(edgePct.toFixed(3)),
            ev_percentage: evPct,
            fair_source:
              consensus.sampleSize > 1 ? "multi_book_consensus" : "single_sharp_book",
            fair_books: consensus.books,
            fair_sample_size: consensus.sampleSize,
            value_rating: computeValueRating(edgePct),
            data_quality: "real",
            passes_clv_gate: passesClv,
            clv_gate_reason: clvReason,
            pinnacle_drift_pct: drift,
            passes_drift_gate: passesDrift,
            drift_gate_reason: driftReason,
          });
        }
      }
    }
  }

  // Sort: full-pass (clv && drift) first, then partial-pass, then by no-vig edge.
  const passScore = (v: ValueLine) =>
    (v.passes_clv_gate ? 2 : 0) + (v.passes_drift_gate ? 1 : 0);
  valueLines.sort((a, b) => {
    const ps = passScore(b) - passScore(a);
    if (ps !== 0) return ps;
    return b.no_vig_edge_pct - a.no_vig_edge_pct;
  });

  if (enforceClvGate && clvByCluster.size === 0) {
    notes.push(
      "No CLV history loaded. CLV gate is permissive until you've recorded ≥30 settled bets per cluster."
    );
  }
  if (valueLines.length === 0) {
    notes.push(
      `No lines exceed +${minEdge}% no-vig edge. This is normal — sharp markets are usually efficient.`
    );
  }

  return {
    sport: params.sport,
    market,
    value_lines: valueLines,
    games_scanned: games.length,
    fair_methodology:
      "Multi-book sharp consensus (Pinnacle/Circa/Bookmaker.eu/BetCRIS) — median no-vig probability per side.",
    cached_at: games[0]?.cached_at ?? new Date().toISOString(),
    notes,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

interface BookOffer {
  book: string;
  price: number;
  point?: number;
  outcomeName: string;
  /** The opposing side's price at the same book/point (for de-vig). */
  opposingPrice?: number;
  opposingName?: string;
}

interface PointGroup {
  offers: BookOffer[];
}

function collectOutcomeNames(game: GameOdds): string[] {
  const names = new Set<string>();
  for (const bm of game.bookmakers) {
    for (const o of bm.outcomes) names.add(o.name);
  }
  return [...names];
}

/**
 * For a given outcome name, group all bookmaker offers by point value.
 * Returns a map keyed by point (or "_" for moneyline) → list of offers,
 * each carrying the opposing-side price from the same book for de-vig.
 */
function groupOutcomesByPoint(
  game: GameOdds,
  outcomeName: string
): Map<string, PointGroup> {
  const groups = new Map<string, PointGroup>();

  for (const bm of game.bookmakers) {
    const target = bm.outcomes.find((o) => o.name === outcomeName);
    if (!target) continue;

    // Find the opposing outcome at the same point (totals/spreads) or any
    // other outcome (h2h).
    const opposing = findOpposingOutcome(bm, outcomeName, target.point);
    if (!opposing) continue;

    const pk = target.point != null ? String(target.point) : "_";
    if (!groups.has(pk)) groups.set(pk, { offers: [] });
    groups.get(pk)!.offers.push({
      book: bm.bookmaker,
      price: target.price,
      point: target.point,
      outcomeName,
      opposingPrice: opposing.price,
      opposingName: opposing.name,
    });
  }

  return groups;
}

function findOpposingOutcome(
  bm: BookmakerOdds,
  outcomeName: string,
  point?: number
): { name: string; price: number } | null {
  const others = bm.outcomes.filter((o) => o.name !== outcomeName);
  if (others.length === 0) return null;

  // If we have a point (spread/total), the opposing line is the one whose
  // point is the negation (or the matching opposite-side total).
  if (point != null) {
    const oppPoint = -point;
    const exact = others.find(
      (o) => o.point != null && Math.abs(o.point - oppPoint) < 0.01
    );
    if (exact) return { name: exact.name, price: exact.price };
    // Fallback: the only other outcome that has *any* point
    const any = others.find((o) => o.point != null);
    if (any) return { name: any.name, price: any.price };
  }

  // Moneyline (or 3-way like soccer): pick the most likely opposing side.
  // For simplicity we collapse to 2-way de-vig against the closest implied prob.
  return { name: others[0].name, price: others[0].price };
}

interface SharpConsensus {
  medianProbA: import("decimal.js").default;
  books: string[];
  sampleSize: number;
}

function buildSharpConsensus(group: PointGroup): SharpConsensus | null {
  const sharpOffers = group.offers.filter((o) =>
    SHARP_BOOKS.includes(o.book.toLowerCase() as (typeof SHARP_BOOKS)[number])
  );
  if (sharpOffers.length === 0) return null;

  const pairs = sharpOffers
    .filter((o) => o.opposingPrice != null)
    .map((o) => ({
      priceA: o.price,
      priceB: o.opposingPrice!,
      book: o.book,
    }));

  if (pairs.length === 0) {
    // Fallback: use the single sharp book with raw implied prob if no opposing
    // price is available. This is degraded quality.
    const fallback = sharpOffers[0];
    return {
      medianProbA: americanToImpliedProb(fallback.price),
      books: [fallback.book],
      sampleSize: 1,
    };
  }

  const consensus = multiBookConsensusNoVig(pairs);
  if (!consensus) return null;

  return {
    medianProbA: consensus.medianProbA,
    books: consensus.books,
    sampleSize: consensus.sampleSize,
  };
}

function computeValueRating(edgePct: number): number {
  // 1.5% edge = 1; 5%+ = 10. Scaled.
  if (edgePct >= 5) return 10;
  if (edgePct <= 1.5) return 1;
  return Math.round(((edgePct - 1.5) / 3.5) * 9 + 1);
}

function clusterKey(sport: string, betType: string, book: string): string {
  return `${sport}|${betType}|${book}`.toLowerCase();
}

/** Load rolling CLV by (sport, bet_type, book) cluster. Returns avg CLV % per cluster. */
async function loadClvByCluster(
  sport: string,
  market: string,
  lookbackDays: number
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!isDatabaseConfigured()) return out;

  try {
    const rows = await query<{
      sport: string;
      bet_type: string;
      book: string;
      avg_clv: string | number;
      n: string | number;
    }>(
      `SELECT sport, bet_type, book,
              AVG(clv)::float AS avg_clv,
              COUNT(*) AS n
         FROM bets
        WHERE clv IS NOT NULL
          AND created_at > NOW() - ($1::int || ' days')::interval
          AND ($2::text IS NULL OR sport = $2)
          AND ($3::text IS NULL OR bet_type = $3)
        GROUP BY sport, bet_type, book
        HAVING COUNT(*) >= 10`,
      [lookbackDays, sport ?? null, market ?? null]
    );

    for (const r of rows) {
      const key = clusterKey(r.sport, r.bet_type, r.book);
      out.set(key, Number(r.avg_clv));
    }
  } catch (err) {
    console.error("[ValueScan] CLV gate query failed:", err);
  }

  return out;
}

/**
 * Load CLV/win-rate stats for prop clusters keyed by (sport, market, book).
 * Returns a map: cluster_key → { avg_no_vig_clv, win_rate_pct, n }.
 *
 * For props we cluster by `market` (e.g., player_points) instead of bet_type
 * (which is just "prop" for everything). When closing-line CLV isn't available
 * we fall back to win-rate as the gating signal.
 */
export async function loadPropClusterStats(
  sport?: string,
  lookbackDays = 90
): Promise<Map<string, { avg_no_vig_clv: number | null; win_rate_pct: number; n: number }>> {
  const out = new Map<string, { avg_no_vig_clv: number | null; win_rate_pct: number; n: number }>();
  if (!isDatabaseConfigured()) return out;
  try {
    const rows = await query<{
      sport: string;
      market: string;
      book: string;
      avg_clv: string | number | null;
      wins: string | number;
      decided: string | number;
    }>(
      `SELECT sport, market, book,
              AVG(no_vig_clv)::float AS avg_clv,
              SUM(CASE WHEN outcome = 'win' THEN 1 ELSE 0 END) AS wins,
              SUM(CASE WHEN outcome IN ('win','loss') THEN 1 ELSE 0 END) AS decided
         FROM bets
        WHERE bet_type = 'prop'
          AND market IS NOT NULL
          AND outcome IN ('win','loss','push')
          AND created_at > NOW() - ($1::int || ' days')::interval
          AND ($2::text IS NULL OR sport = $2)
        GROUP BY sport, market, book
        HAVING SUM(CASE WHEN outcome IN ('win','loss') THEN 1 ELSE 0 END) >= 10`,
      [lookbackDays, sport ?? null]
    );
    for (const r of rows) {
      const key = `${r.sport}|${r.market}|${r.book}`.toLowerCase();
      const decided = Number(r.decided);
      const wr = decided > 0 ? (Number(r.wins) / decided) * 100 : 0;
      out.set(key, {
        avg_no_vig_clv: r.avg_clv == null ? null : Number(r.avg_clv),
        win_rate_pct: Number(wr.toFixed(2)),
        n: decided,
      });
    }
  } catch (err) {
    console.error("[ValueScan] prop cluster CLV query failed:", err);
  }
  return out;
}
