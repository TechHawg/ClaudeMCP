/**
 * NFL backfill via nflverse's free GitHub releases (no API key needed).
 *
 * nflverse publishes weekly per-player stats as CSV at predictable URLs:
 *   https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_{YYYY}.csv
 *
 * If that file changes shape across seasons, we tolerate missing columns.
 *
 * NOTE: NFL games happen weekly Sun/Mon/Thu, so "days_back" is mapped to seasons:
 *   - Default: pull current and previous regular-season files.
 */

import axios from "axios";
import { upsertStatBatch, type PropStatRecord } from "./util.js";

const URL_TPL = (year: number) =>
  `https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_${year}.csv`;

export async function backfillNFL(params: {
  seasons?: number[]; // e.g. [2024, 2025]
  source_label?: string;
} = {}): Promise<{ seasons: number[]; rows_inserted: number; files_fetched: number }> {
  const source = params.source_label ?? "nflverse";
  const now = new Date();
  const currentSeason = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
  const seasons = params.seasons ?? [currentSeason, currentSeason - 1];
  let totalInserted = 0;
  let filesFetched = 0;

  for (const year of seasons) {
    try {
      const resp = await axios.get<string>(URL_TPL(year), {
        responseType: "text",
        timeout: 60000,
        // Some servers/CDNs reject default Node UA.
        headers: { "User-Agent": "betting-mcp/1.0" },
      });
      filesFetched++;

      const records = parseNflverseCsv(resp.data, year, source);
      totalInserted += await upsertStatBatch(records);
    } catch (err) {
      console.error(`[Backfill/NFL] season ${year} fetch failed:`, err instanceof Error ? err.message : err);
    }
  }

  return { seasons, rows_inserted: totalInserted, files_fetched: filesFetched };
}

// ── CSV parsing ──────────────────────────────────────────────────────────────

/** Minimal RFC4180-ish CSV parser (handles quoted fields with commas/newlines). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { cur.push(field); field = ""; }
      else if (c === "\n") { cur.push(field); rows.push(cur); cur = []; field = ""; }
      else if (c === "\r") { /* skip */ }
      else field += c;
    }
  }
  if (field.length > 0 || cur.length > 0) { cur.push(field); rows.push(cur); }
  return rows;
}

function parseNflverseCsv(csv: string, season: number, source: string): PropStatRecord[] {
  const rows = parseCsv(csv);
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim());
  const idx = (name: string) => header.indexOf(name);

  // Common columns across nflverse weekly files. Tolerate missing.
  const PLAYER_COL = idx("player_display_name") !== -1 ? idx("player_display_name") : idx("player_name");
  const SEASON_COL = idx("season");
  const WEEK_COL = idx("week");
  const SEASON_TYPE_COL = idx("season_type");
  const RECENT_TEAM_COL = idx("recent_team") !== -1 ? idx("recent_team") : idx("team");
  const OPPONENT_COL = idx("opponent_team");

  const cols: Record<string, number> = {
    passing_yards: idx("passing_yards"),
    passing_tds: idx("passing_tds"),
    completions: idx("completions"),
    attempts: idx("attempts"),
    interceptions: idx("interceptions"),
    rushing_yards: idx("rushing_yards"),
    rushing_tds: idx("rushing_tds"),
    carries: idx("carries"),
    receiving_yards: idx("receiving_yards"),
    receiving_tds: idx("receiving_tds"),
    receptions: idx("receptions"),
    targets: idx("targets"),
  };

  // Skip the header
  const records: PropStatRecord[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length < 3) continue;

    const player = (PLAYER_COL >= 0 ? row[PLAYER_COL] : "").trim();
    if (!player) continue;

    const week = WEEK_COL >= 0 ? Number(row[WEEK_COL]) : null;
    const seasonType = SEASON_TYPE_COL >= 0 ? row[SEASON_TYPE_COL]?.trim().toUpperCase() : "REG";
    if (week == null || !Number.isFinite(week)) continue;

    // Approximate game_date from season + week (NFL Week 1 typically Thu after Labor Day).
    // We don't have exact date in this file — use the Sunday of the relevant week as a stable key.
    const gameDate = approximateNflGameDate(season, week, seasonType);

    const team = RECENT_TEAM_COL >= 0 ? row[RECENT_TEAM_COL] : "";
    const opp = OPPONENT_COL >= 0 ? row[OPPONENT_COL] : "";
    const game = team && opp ? `${team} vs ${opp}` : undefined;

    for (const [market, colIdx] of Object.entries(cols)) {
      if (colIdx < 0) continue;
      const raw = row[colIdx];
      if (raw == null || raw === "") continue;
      const val = Number(raw);
      if (!Number.isFinite(val)) continue;
      records.push({
        player_name: player,
        sport: "nfl",
        market: `player_${market}`,
        actual_value: val,
        game_date: gameDate,
        game,
        source,
      });
    }
  }
  return records;
}

/** NFL Week 1 typically falls in early September. Approximate the Sunday of week N. */
function approximateNflGameDate(season: number, week: number, seasonType: string): string {
  // Week 1 anchored to first Sunday on or after Sept 5.
  const sept5 = new Date(Date.UTC(season, 8, 5));
  const dow = sept5.getUTCDay(); // 0 = Sun
  const offsetToSunday = (7 - dow) % 7;
  const week1Sunday = new Date(sept5.getTime() + offsetToSunday * 24 * 3600 * 1000);
  const wk = seasonType === "POST" ? week + 18 : week; // postseason after week 18-ish
  const target = new Date(week1Sunday.getTime() + (wk - 1) * 7 * 24 * 3600 * 1000);
  return target.toISOString().slice(0, 10);
}
