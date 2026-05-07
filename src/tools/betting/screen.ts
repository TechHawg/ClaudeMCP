/**
 * Screen Plays — single end-to-end tool that returns ranked, gated candidates.
 *
 * This replaces the Claude workflow of:
 *   1. get_live_odds, 2. find_value_line, 3. get_sharp_action, 4. pinnacle_drift,
 *   5. get_confidence_score, 6. shop_lines, 7. kelly_bet_size
 * with a single call. It runs the no-vig + CLV + drift gates server-side,
 * computes Kelly sizing per cluster, and returns only the plays that survive.
 *
 * Returns at most `top_n` plays (default 10), sorted by Kelly stake descending.
 */

import { findValueLines, type ValueLine } from "./value.js";
import { getSharpAction } from "./sharp.js";
import { calculateKelly } from "./kelly.js";
import { scanProps, type PropEdgePlay } from "./scan_props.js";
import { resolveSportKey, type DataQuality } from "../../utils/helpers.js";
import { logBetRejection } from "../learning/rejection_log.js";
import { logSystemRecommendations } from "../learning/system_recommendations.js";

export interface ScreenedPlay {
  rank: number;
  sport: string;
  game: string;
  market: string;
  side: string;
  point?: number;
  best_book: string;
  best_price: number;
  fair_prob_pct: number;
  no_vig_edge_pct: number;
  ev_percentage: number;
  pinnacle_drift_pct?: number;
  /** Sharp signal from get_sharp_action when available. */
  sharp_signal?: {
    sharp_side: string;
    sharp_pct: number;
    rlm: boolean;
    steam: boolean;
    data_quality: DataQuality;
  };
  // Sizing
  kelly_fraction_used: number;
  recommended_stake: number;
  kelly_warning?: string;
  // Gates
  passes_clv_gate: boolean;
  clv_gate_reason: string;
  passes_drift_gate: boolean;
  drift_gate_reason: string;
  data_quality: DataQuality;
}

export interface ScreenResult {
  generated_at: string;
  sports_scanned: string[];
  bankroll: number;
  total_candidates_examined: number;
  total_passed_gates: number;
  total_rejected: number;
  plays: ScreenedPlay[];
  rejections_summary: Record<string, number>;
  notes: string[];
}

export async function screenPlays(params: {
  bankroll: number;
  sports?: string[];
  markets?: string[];
  /** Minimum no-vig edge in pct points (default 1.5). */
  min_edge_pct?: number;
  /** Top N plays to return (default 10). */
  top_n?: number;
  /** If true (default), respect CLV/drift gates and drop failures. */
  enforce_gates?: boolean;
  /** Log rejections to bet_rejections table (default true). */
  log_rejections?: boolean;
  /** If true (default), also scan player props per sport. Adds API quota cost. */
  include_props?: boolean;
  /** Minimum prop no-vig edge (default 2.5 — props are noisier). */
  min_prop_edge_pct?: number;
}): Promise<ScreenResult> {
  const sports = params.sports ?? ["nba", "mlb", "nhl"];
  const markets = params.markets ?? ["h2h", "spreads", "totals"];
  const minEdge = params.min_edge_pct ?? 1.5;
  const topN = params.top_n ?? 10;
  const enforceGates = params.enforce_gates ?? true;
  const logRejections = params.log_rejections ?? true;
  const includeProps = params.include_props ?? true;
  const minPropEdge = params.min_prop_edge_pct ?? 2.5;

  const candidates: Array<ValueLine & { sport: string; market: string }> = [];
  const sharpBySportGame = new Map<string, Awaited<ReturnType<typeof getSharpAction>>[number]>();
  const notes: string[] = [];
  let totalExamined = 0;
  const rejectionsByReason: Record<string, number> = {};

  for (const sport of sports) {
    const sportKey = resolveSportKey(sport);

    // Fetch sharp action for this sport once, index by game string.
    try {
      const sharp = await getSharpAction({ sport });
      for (const s of sharp) sharpBySportGame.set(`${sportKey}|${s.game.toLowerCase()}`, s);
    } catch (err) {
      notes.push(`Sharp action unavailable for ${sport}: ${err instanceof Error ? err.message : String(err)}`);
    }

    for (const market of markets) {
      try {
        const scan = await findValueLines({
          sport,
          bet_type: market,
          min_edge_pct: minEdge,
          enforce_clv_gate: enforceGates,
          enforce_drift_gate: enforceGates,
        });
        totalExamined += scan.value_lines.length;
        for (const v of scan.value_lines) {
          candidates.push({ ...v, sport: sportKey, market });
        }
      } catch (err) {
        notes.push(`Value scan failed ${sport}/${market}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Player props (optional — adds API cost). Mapped onto the same candidate
    // shape so the rest of the pipeline (Kelly sizing, ranking) is uniform.
    if (includeProps) {
      try {
        const props = await scanProps({
          sport,
          min_edge_pct: minPropEdge,
          include_hit_rate: true,
        });
        totalExamined += props.plays.length;
        for (const pp of props.plays) {
          candidates.push(propToValueLineCandidate(pp, sportKey));
        }
      } catch (err) {
        notes.push(`Prop scan failed ${sport}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Filter and rank.
  const plays: ScreenedPlay[] = [];
  for (const c of candidates) {
    const gateFailures: string[] = [];
    if (enforceGates && !c.passes_clv_gate) gateFailures.push("clv_gate");
    if (enforceGates && !c.passes_drift_gate) gateFailures.push("drift_gate");

    if (gateFailures.length > 0) {
      for (const reason of gateFailures) {
        rejectionsByReason[reason] = (rejectionsByReason[reason] ?? 0) + 1;
        if (logRejections) {
          await logBetRejection({
            sport: c.sport,
            bet_type: c.market,
            book: c.best_book,
            side: c.side,
            game: c.game,
            no_vig_edge_pct: c.no_vig_edge_pct,
            reason,
            reason_detail:
              reason === "clv_gate" ? c.clv_gate_reason : c.drift_gate_reason,
            raw_signal: { fair_prob_pct: c.fair_prob_pct, ev_percentage: c.ev_percentage },
          });
        }
      }
      continue;
    }

    // Kelly sizing — per-market fraction auto-resolved.
    const kelly = await calculateKelly({
      bankroll: params.bankroll,
      edge_percentage: c.no_vig_edge_pct,
      odds: c.best_price,
      edge_is_no_vig: true,
      sport: c.sport,
      bet_type: c.market,
      book: c.best_book,
    });

    if (kelly.recommendedBet <= 0) {
      rejectionsByReason["kelly_zero"] = (rejectionsByReason["kelly_zero"] ?? 0) + 1;
      if (logRejections) {
        await logBetRejection({
          sport: c.sport,
          bet_type: c.market,
          book: c.best_book,
          side: c.side,
          game: c.game,
          no_vig_edge_pct: c.no_vig_edge_pct,
          reason: "kelly_zero",
          reason_detail: kelly.warning ?? "Kelly returned 0 — likely market bankroll override.",
        });
      }
      continue;
    }

    // Cross-reference sharp signal
    let sharp_signal: ScreenedPlay["sharp_signal"];
    const sharpKey = `${c.sport}|${c.game.toLowerCase()}`;
    const sharpAction = sharpBySportGame.get(sharpKey);
    if (sharpAction) {
      sharp_signal = {
        sharp_side: sharpAction.sharp_side,
        sharp_pct: sharpAction.sharp_pct,
        rlm: sharpAction.reverse_line_movement,
        steam: sharpAction.steam_move_alert,
        data_quality: sharpAction.data_quality ?? "inferred",
      };
    }

    plays.push({
      rank: 0, // filled after sort
      sport: c.sport,
      game: c.game,
      market: c.market,
      side: c.side,
      point: c.point,
      best_book: c.best_book,
      best_price: c.best_price,
      fair_prob_pct: c.fair_prob_pct,
      no_vig_edge_pct: c.no_vig_edge_pct,
      ev_percentage: c.ev_percentage,
      pinnacle_drift_pct: c.pinnacle_drift_pct,
      sharp_signal,
      kelly_fraction_used: kelly.kelly_fraction_used,
      recommended_stake: kelly.recommendedBet,
      kelly_warning: kelly.warning,
      passes_clv_gate: c.passes_clv_gate,
      clv_gate_reason: c.clv_gate_reason,
      passes_drift_gate: c.passes_drift_gate,
      drift_gate_reason: c.drift_gate_reason,
      data_quality: c.data_quality,
    });
  }

  // Sort by recommended stake desc (which is monotonic in Kelly%, which is monotonic in edge*price).
  plays.sort((a, b) => b.recommended_stake - a.recommended_stake);
  for (let i = 0; i < plays.length; i++) plays[i].rank = i + 1;
  const top = plays.slice(0, topN);

  // Auto-log system recommendations so we have a track record of the system
  // separate from the user's actual bets. Fire-and-forget; failure here must
  // not break the screen.
  if (top.length > 0) {
    const scanId = `scan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    logSystemRecommendations(
      scanId,
      top.map((p) => ({
        scan_id: scanId,
        sport: p.sport,
        market: p.market,
        game: p.game,
        side: p.side,
        point: p.point,
        best_book: p.best_book,
        best_price: p.best_price,
        no_vig_edge_pct: p.no_vig_edge_pct,
        ev_percentage: p.ev_percentage,
        recommended_stake: p.recommended_stake,
        kelly_fraction: p.kelly_fraction_used,
      }))
    ).catch((err) => console.error("[ScreenPlays] system rec log failed:", err));
  }

  if (top.length === 0) {
    notes.push(
      "No plays passed all gates today. This is normal — sharp markets are usually efficient. Pass enforce_gates=false to see candidates that failed gates and understand why."
    );
  }

  const totalRejected = Object.values(rejectionsByReason).reduce((s, n) => s + n, 0);

  return {
    generated_at: new Date().toISOString(),
    sports_scanned: sports,
    bankroll: params.bankroll,
    total_candidates_examined: totalExamined,
    total_passed_gates: plays.length,
    total_rejected: totalRejected,
    plays: top,
    rejections_summary: rejectionsByReason,
    notes,
  };
}

/**
 * Map a PropEdgePlay (from scan_props) into the same candidate shape used by
 * findValueLines so screen_plays can size and gate it uniformly.
 *
 * Note: prop plays bypass the per-cluster CLV gate and drift gate for now —
 * those need per-prop history that doesn't exist yet. They still benefit from
 * per-market Kelly sizing and the drawdown breaker.
 */
function propToValueLineCandidate(
  pp: PropEdgePlay,
  sportKey: string
): ValueLine & { sport: string; market: string } {
  return {
    sport: sportKey,
    market: pp.market,
    game: pp.game,
    side: `${pp.player} ${pp.side} ${pp.line} (${pp.market})`,
    point: pp.line,
    best_book: pp.best_book,
    best_price: pp.best_price,
    best_decimal: pp.best_price > 0 ? pp.best_price / 100 + 1 : 100 / -pp.best_price + 1,
    fair_prob_pct: pp.fair_prob_pct,
    book_prob_pct: 100 - pp.fair_prob_pct + pp.no_vig_edge_pct,
    no_vig_edge_pct: pp.no_vig_edge_pct,
    ev_percentage: pp.ev_percentage,
    fair_source: pp.fair_source,
    fair_books: pp.fair_books,
    fair_sample_size: pp.fair_sample_size,
    value_rating:
      pp.no_vig_edge_pct >= 5 ? 10
        : pp.no_vig_edge_pct <= 1.5 ? 1
          : Math.round(((pp.no_vig_edge_pct - 1.5) / 3.5) * 9 + 1),
    data_quality: pp.data_quality,
    passes_clv_gate: true,
    clv_gate_reason: "CLV gate not applicable to prop scans (no per-market history yet).",
    passes_drift_gate: true,
    drift_gate_reason: "Drift gate not applicable to prop scans.",
  };
}
