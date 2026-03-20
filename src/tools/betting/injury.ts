/**
 * Injury + Lineup Feed.
 * Attempts Rotowire API, falls back to SportsRadar injuries endpoint.
 *
 * Rotowire API — Paid, contact for pricing at rotowire.com
 * SportsRadar — Free trial: 1,000 calls/month per sport
 */

import axios from "axios";
import { formatApiError, resolveSportKey } from "../../utils/helpers.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface InjuryEntry {
  player_name: string;
  team: string;
  position: string;
  status: "Out" | "Doubtful" | "Questionable" | "Probable" | "Day-to-Day" | "Unknown";
  injury_type: string;
  updated: string;
  estimated_line_impact: string;
  impact_severity: "critical" | "significant" | "moderate" | "minor";
}

export interface InjuryReport {
  sport: string;
  team?: string;
  injuries: InjuryEntry[];
  last_updated: string;
  data_source: string;
}

// ── Implementation ───────────────────────────────────────────────────────────

export async function getInjuryReport(params: {
  sport: string;
  team?: string;
  game_date?: string;
}): Promise<InjuryReport> {
  const sportKey = resolveSportKey(params.sport);

  // Try Rotowire first
  const rotowireKey = process.env.ROTOWIRE_API_KEY;
  if (rotowireKey) {
    try {
      return await fetchRotowire(params.sport, rotowireKey, params.team);
    } catch (error) {
      console.error(
        "[Injury] Rotowire fetch failed:",
        formatApiError(error, "Rotowire")
      );
    }
  }

  // Try SportsRadar injuries endpoint
  const srKey = process.env.SPORTRADAR_API_KEY;
  if (srKey) {
    try {
      return await fetchSportsRadarInjuries(params.sport, srKey, params.team);
    } catch (error) {
      console.error(
        "[Injury] SportsRadar fetch failed:",
        formatApiError(error, "SportsRadar")
      );
    }
  }

  return {
    sport: params.sport,
    team: params.team,
    injuries: [],
    last_updated: new Date().toISOString(),
    data_source: "No injury data source configured. Set ROTOWIRE_API_KEY or SPORTRADAR_API_KEY.",
  };
}

// ── Rotowire fetch ───────────────────────────────────────────────────────────

async function fetchRotowire(
  sport: string,
  apiKey: string,
  team?: string
): Promise<InjuryReport> {
  const sportMap: Record<string, string> = {
    nfl: "nfl",
    nba: "nba",
    mlb: "mlb",
    nhl: "nhl",
  };

  const sportSlug = sportMap[sport.toLowerCase()] ?? sport.toLowerCase();

  const resp = await axios.get(
    `https://api.rotowire.com/injuries/v1/${sportSlug}`,
    {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 15000,
    }
  );

  let injuries: InjuryEntry[] = (resp.data?.injuries ?? []).map(
    (inj: Record<string, unknown>): InjuryEntry => ({
      player_name: String(inj.player ?? ""),
      team: String(inj.team ?? ""),
      position: String(inj.position ?? ""),
      status: normalizeStatus(String(inj.status ?? "")),
      injury_type: String(inj.injury ?? "Unknown"),
      updated: String(inj.updated ?? new Date().toISOString()),
      estimated_line_impact: estimateLineImpact(
        String(inj.position ?? ""),
        normalizeStatus(String(inj.status ?? "")),
        sport
      ),
      impact_severity: estimateImpactSeverity(
        String(inj.position ?? ""),
        normalizeStatus(String(inj.status ?? ""))
      ),
    })
  );

  if (team) {
    injuries = injuries.filter((i) =>
      i.team.toLowerCase().includes(team.toLowerCase())
    );
  }

  return {
    sport,
    team,
    injuries,
    last_updated: new Date().toISOString(),
    data_source: "Rotowire",
  };
}

// ── SportsRadar injuries ─────────────────────────────────────────────────────

async function fetchSportsRadarInjuries(
  sport: string,
  apiKey: string,
  team?: string
): Promise<InjuryReport> {
  const sportPaths: Record<string, string> = {
    nba: "nba/trial/v8/en",
    mlb: "mlb/trial/v7/en",
    nhl: "nhl/trial/v7/en",
    ncaab: "ncaamb/trial/v8/en",
    ncaamb: "ncaamb/trial/v8/en",
    soccer: "soccer/trial/v4/en",
    golf: "golf/trial/v3/en",
  };

  const sportPath = sportPaths[sport.toLowerCase()];
  if (!sportPath) {
    throw new Error(`Unsupported sport for SportsRadar injuries: ${sport}`);
  }

  const resp = await axios.get(
    `https://api.sportradar.com/${sportPath}/league/injuries.json`,
    {
      params: { api_key: apiKey },
      timeout: 15000,
    }
  );

  const teams = resp.data?.teams ?? resp.data?.season?.teams ?? [];
  let injuries: InjuryEntry[] = [];

  for (const t of teams) {
    const teamName = t.name ?? t.market ?? "";
    const players = t.players ?? [];

    for (const p of players) {
      if (!p.injuries?.length) continue;
      const inj = p.injuries[0]; // most recent injury
      injuries.push({
        player_name: `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim(),
        team: teamName,
        position: p.position ?? "",
        status: normalizeStatus(inj.status ?? ""),
        injury_type: inj.description ?? "Unknown",
        updated: inj.update_date ?? new Date().toISOString(),
        estimated_line_impact: estimateLineImpact(
          p.position ?? "",
          normalizeStatus(inj.status ?? ""),
          sport
        ),
        impact_severity: estimateImpactSeverity(
          p.position ?? "",
          normalizeStatus(inj.status ?? "")
        ),
      });
    }
  }

  if (team) {
    injuries = injuries.filter((i) =>
      i.team.toLowerCase().includes(team.toLowerCase())
    );
  }

  return {
    sport,
    team,
    injuries,
    last_updated: new Date().toISOString(),
    data_source: "SportsRadar",
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalizeStatus(
  raw: string
): InjuryEntry["status"] {
  const lower = raw.toLowerCase();
  if (lower.includes("out") || lower === "o") return "Out";
  if (lower.includes("doubtful") || lower === "d") return "Doubtful";
  if (lower.includes("questionable") || lower === "q") return "Questionable";
  if (lower.includes("probable") || lower === "p") return "Probable";
  if (lower.includes("day")) return "Day-to-Day";
  return "Unknown";
}

function estimateLineImpact(
  position: string,
  status: InjuryEntry["status"],
  sport: string
): string {
  if (status === "Probable") return "Minimal line impact — likely to play.";

  const pos = position.toLowerCase();
  const sportLower = sport.toLowerCase();

  // Key positions by sport
  if (sportLower === "nfl") {
    if (pos === "qb") return "Major impact — 3-7 point line swing depending on backup quality.";
    if (["rb", "wr", "te"].includes(pos))
      return "Moderate impact — 0.5-2 points, affects totals and player props.";
    if (pos.includes("ol") || pos.includes("ot") || pos.includes("og"))
      return "Sneaky impact — affects run game and sack rates, watch totals.";
  }
  if (sportLower === "nba") {
    if (pos === "c" || pos === "pf" || pos === "pg")
      return "Significant impact — star players move lines 3-5 points.";
  }
  if (sportLower === "mlb") {
    if (pos === "sp" || pos === "p")
      return "Major impact — starting pitcher is the biggest line mover in baseball.";
  }
  if (sportLower === "nhl") {
    if (pos === "g")
      return "Major impact — starting goalie is the most important position in NHL betting.";
  }

  return status === "Out"
    ? "Moderate impact — player confirmed out."
    : "Monitor status — update closer to game time.";
}

function estimateImpactSeverity(
  position: string,
  status: InjuryEntry["status"]
): InjuryEntry["impact_severity"] {
  if (status === "Probable") return "minor";

  const pos = position.toLowerCase();
  const isKeyPosition =
    pos === "qb" ||
    pos === "sp" ||
    pos === "p" ||
    pos === "g" ||
    pos === "c" ||
    pos === "pg";

  if (isKeyPosition && (status === "Out" || status === "Doubtful"))
    return "critical";
  if (isKeyPosition) return "significant";
  if (status === "Out") return "moderate";
  return "minor";
}
