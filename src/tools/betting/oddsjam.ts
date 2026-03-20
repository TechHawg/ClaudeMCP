/**
 * OddsJam API integration for positive EV data.
 * OddsJam provides pre-computed +EV bets, sharp vs soft line comparisons.
 *
 * Paid API — starts at $99/month for API access.
 * Endpoint: GET https://api.oddsjam.com/v2/positive-ev
 * Docs: https://oddsjam.com/odds-api
 */

import axios from "axios";
import { formatApiError } from "../../utils/helpers.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface OddsJamPositiveEV {
  sport: string;
  game: string;
  market: string;
  side: string;
  book: string;
  odds: number;
  fair_odds: number;
  ev_percentage: number;
  sharp_line_source: string;
  timestamp: string;
}

export interface OddsJamResult {
  source: "oddsjam";
  positive_ev_bets: OddsJamPositiveEV[];
  total_found: number;
  cached_at: string;
}

// ── Implementation ───────────────────────────────────────────────────────────

export async function getOddsJamPositiveEV(params: {
  sport?: string;
  min_ev?: number;
  sportsbook?: string;
}): Promise<OddsJamResult> {
  const apiKey = process.env.ODDSJAM_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ODDSJAM_API_KEY not set. OddsJam API requires a paid subscription starting at $99/month. " +
        "Sign up at https://oddsjam.com/odds-api"
    );
  }

  try {
    const queryParams: Record<string, string | number> = {};
    if (params.sport) queryParams.sport = params.sport;
    if (params.min_ev) queryParams.min_ev = params.min_ev;
    if (params.sportsbook) queryParams.sportsbook = params.sportsbook;

    // OddsJam API v2 — positive EV endpoint
    const resp = await axios.get(
      "https://api.oddsjam.com/v2/positive-ev",
      {
        headers: {
          "x-api-key": apiKey,
          Accept: "application/json",
        },
        params: queryParams,
        timeout: 15000,
      }
    );

    const bets = (resp.data?.data ?? resp.data ?? []).map(
      (bet: Record<string, unknown>): OddsJamPositiveEV => ({
        sport: String(bet.sport ?? ""),
        game: String(bet.game ?? bet.event ?? ""),
        market: String(bet.market ?? bet.market_name ?? ""),
        side: String(bet.bet_name ?? bet.selection ?? ""),
        book: String(bet.sportsbook ?? bet.book ?? ""),
        odds: Number(bet.odds ?? bet.price ?? 0),
        fair_odds: Number(bet.fair_odds ?? bet.no_vig_price ?? 0),
        ev_percentage: Number(bet.ev ?? bet.ev_percentage ?? 0),
        sharp_line_source: String(bet.sharp_source ?? "Pinnacle"),
        timestamp: String(bet.timestamp ?? new Date().toISOString()),
      })
    );

    return {
      source: "oddsjam",
      positive_ev_bets: bets,
      total_found: bets.length,
      cached_at: new Date().toISOString(),
    };
  } catch (error) {
    throw new Error(formatApiError(error, "OddsJam"));
  }
}
