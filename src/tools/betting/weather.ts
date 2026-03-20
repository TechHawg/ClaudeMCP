/**
 * Weather Impact for Outdoor Games.
 * Uses OpenWeatherMap API — Free tier: 1,000 calls/day.
 * Endpoint: GET https://api.openweathermap.org/data/2.5/forecast
 */

import axios from "axios";
import { formatApiError } from "../../utils/helpers.js";

// ── Stadium coordinates database ─────────────────────────────────────────────

const STADIUM_COORDS: Record<string, { lat: number; lon: number; indoor: boolean }> = {
  // NFL outdoor stadiums
  "arrowhead_stadium": { lat: 39.0489, lon: -94.4839, indoor: false },
  "lambeau_field": { lat: 44.5013, lon: -88.0622, indoor: false },
  "soldier_field": { lat: 41.8623, lon: -87.6167, indoor: false },
  "highmark_stadium": { lat: 42.7738, lon: -78.7870, indoor: false },
  "metlife_stadium": { lat: 40.8128, lon: -74.0742, indoor: false },
  "gillette_stadium": { lat: 42.0909, lon: -71.2643, indoor: false },
  "lincoln_financial_field": { lat: 39.9008, lon: -75.1675, indoor: false },
  "fedex_field": { lat: 38.9076, lon: -76.8645, indoor: false },
  "bank_of_america_stadium": { lat: 35.2258, lon: -80.8528, indoor: false },
  "raymond_james_stadium": { lat: 27.9759, lon: -82.5033, indoor: false },
  "hard_rock_stadium": { lat: 25.9580, lon: -80.2389, indoor: false },
  "levi_stadium": { lat: 37.4033, lon: -121.9694, indoor: false },
  "empower_field": { lat: 39.7439, lon: -105.0201, indoor: false },
  "paycor_stadium": { lat: 39.0955, lon: -84.5161, indoor: false },
  "cleveland_browns_stadium": { lat: 41.5061, lon: -81.6995, indoor: false },
  "heinz_field": { lat: 40.4468, lon: -80.0158, indoor: false },
  "nissan_stadium": { lat: 36.1664, lon: -86.7713, indoor: false },
  "tiaa_bank_field": { lat: 30.3239, lon: -81.6373, indoor: false },
  // MLB outdoor stadiums (most are outdoor)
  "yankee_stadium": { lat: 40.8296, lon: -73.9262, indoor: false },
  "fenway_park": { lat: 42.3467, lon: -71.0972, indoor: false },
  "wrigley_field": { lat: 41.9484, lon: -87.6553, indoor: false },
  "dodger_stadium": { lat: 34.0739, lon: -118.2400, indoor: false },
  "coors_field": { lat: 39.7559, lon: -104.9942, indoor: false },
  // Indoor stadiums (weather doesn't matter)
  "sofi_stadium": { lat: 33.9534, lon: -118.3390, indoor: true },
  "allegiant_stadium": { lat: 36.0909, lon: -115.1833, indoor: true },
  "at_t_stadium": { lat: 32.7473, lon: -97.0945, indoor: true },
  "caesars_superdome": { lat: 29.9511, lon: -90.0812, indoor: true },
  "us_bank_stadium": { lat: 44.9736, lon: -93.2575, indoor: true },
  "state_farm_stadium": { lat: 33.5276, lon: -112.2626, indoor: true },
  "lucas_oil_stadium": { lat: 39.7601, lon: -86.1639, indoor: true },
  "nrg_stadium": { lat: 29.6847, lon: -95.4107, indoor: true },
  "mercedes_benz_stadium": { lat: 33.7554, lon: -84.4010, indoor: true },
};

// ── Types ────────────────────────────────────────────────────────────────────

export interface WeatherReport {
  stadium: string;
  is_indoor: boolean;
  temperature_f: number;
  wind_speed_mph: number;
  wind_direction: string;
  precipitation_chance_pct: number;
  conditions: string;
  humidity_pct: number;
  impact_assessment: string;
  betting_impact: BettingImpact[];
  cached_at: string;
}

export interface BettingImpact {
  factor: string;
  effect: string;
  severity: "none" | "low" | "medium" | "high";
}

// ── Implementation ───────────────────────────────────────────────────────────

export async function getWeather(params: {
  stadium_name: string;
  game_date: string;
}): Promise<WeatherReport> {
  const normalized = params.stadium_name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

  // Find stadium by fuzzy match
  const stadiumKey = findStadium(normalized);
  const stadium = stadiumKey ? STADIUM_COORDS[stadiumKey] : null;

  if (!stadium) {
    // Try to use the name as-is with a geocoding fallback
    return {
      stadium: params.stadium_name,
      is_indoor: false,
      temperature_f: 0,
      wind_speed_mph: 0,
      wind_direction: "N/A",
      precipitation_chance_pct: 0,
      conditions: "Unknown",
      humidity_pct: 0,
      impact_assessment: `Stadium "${params.stadium_name}" not found in database. Known stadiums: ${Object.keys(STADIUM_COORDS).slice(0, 10).join(", ")}...`,
      betting_impact: [],
      cached_at: new Date().toISOString(),
    };
  }

  if (stadium.indoor) {
    return {
      stadium: params.stadium_name,
      is_indoor: true,
      temperature_f: 72,
      wind_speed_mph: 0,
      wind_direction: "N/A",
      precipitation_chance_pct: 0,
      conditions: "Indoor — climate controlled",
      humidity_pct: 50,
      impact_assessment: "Indoor stadium — weather has no impact on this game.",
      betting_impact: [
        { factor: "Indoor", effect: "No weather impact", severity: "none" },
      ],
      cached_at: new Date().toISOString(),
    };
  }

  const apiKey = process.env.OPENWEATHER_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENWEATHER_API_KEY not set. Get a free key (1000 calls/day) at https://openweathermap.org/api"
    );
  }

  try {
    const resp = await axios.get(
      "https://api.openweathermap.org/data/2.5/forecast",
      {
        params: {
          lat: stadium.lat,
          lon: stadium.lon,
          appid: apiKey,
          units: "imperial",
        },
        timeout: 10000,
      }
    );

    // Find forecast closest to game time
    const gameDate = new Date(params.game_date);
    const forecasts = resp.data?.list ?? [];
    let closest = forecasts[0];
    let minDiff = Infinity;

    for (const fc of forecasts) {
      const diff = Math.abs(new Date(fc.dt_txt).getTime() - gameDate.getTime());
      if (diff < minDiff) {
        minDiff = diff;
        closest = fc;
      }
    }

    const temp = closest?.main?.temp ?? 70;
    const windSpeed = closest?.wind?.speed ?? 0;
    const windDeg = closest?.wind?.deg ?? 0;
    const humidity = closest?.main?.humidity ?? 50;
    const precipChance = (closest?.pop ?? 0) * 100;
    const conditions = closest?.weather?.[0]?.description ?? "clear";

    const impacts = assessBettingImpact(temp, windSpeed, precipChance, conditions);
    const assessment = impacts
      .filter((i) => i.severity !== "none")
      .map((i) => `${i.factor}: ${i.effect}`)
      .join(". ") || "Favorable conditions — no significant weather impact expected.";

    return {
      stadium: params.stadium_name,
      is_indoor: false,
      temperature_f: Math.round(temp),
      wind_speed_mph: Math.round(windSpeed),
      wind_direction: degToDirection(windDeg),
      precipitation_chance_pct: Math.round(precipChance),
      conditions,
      humidity_pct: Math.round(humidity),
      impact_assessment: assessment,
      betting_impact: impacts,
      cached_at: new Date().toISOString(),
    };
  } catch (error) {
    throw new Error(formatApiError(error, "OpenWeatherMap"));
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function findStadium(normalized: string): string | null {
  // Exact match
  if (STADIUM_COORDS[normalized]) return normalized;

  // Fuzzy match
  for (const key of Object.keys(STADIUM_COORDS)) {
    if (key.includes(normalized) || normalized.includes(key)) return key;
  }

  // Partial word match
  const words = normalized.split("_");
  for (const key of Object.keys(STADIUM_COORDS)) {
    if (words.some((w) => w.length > 3 && key.includes(w))) return key;
  }

  return null;
}

function degToDirection(deg: number): string {
  const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return dirs[Math.round(deg / 22.5) % 16];
}

function assessBettingImpact(
  temp: number,
  wind: number,
  precip: number,
  conditions: string
): BettingImpact[] {
  const impacts: BettingImpact[] = [];

  // Wind impact (critical for passing/kicking)
  if (wind >= 20) {
    impacts.push({
      factor: `Wind ${Math.round(wind)}mph`,
      effect: "Significant impact — fade passing game totals, consider unders on high totals. Field goals become unreliable.",
      severity: "high",
    });
  } else if (wind >= 15) {
    impacts.push({
      factor: `Wind ${Math.round(wind)}mph`,
      effect: "Moderate wind — slight negative for passing offenses, consider impact on totals.",
      severity: "medium",
    });
  } else if (wind >= 10) {
    impacts.push({
      factor: `Wind ${Math.round(wind)}mph`,
      effect: "Light wind — minimal impact on gameplay.",
      severity: "low",
    });
  }

  // Temperature impact
  if (temp <= 20) {
    impacts.push({
      factor: `Temperature ${Math.round(temp)}°F`,
      effect: "Extreme cold — ball handling issues, shorter passes, run-heavy game scripts. Strong under lean.",
      severity: "high",
    });
  } else if (temp <= 35) {
    impacts.push({
      factor: `Temperature ${Math.round(temp)}°F`,
      effect: "Cold weather — slight under lean, receivers may have trouble catching.",
      severity: "medium",
    });
  } else if (temp >= 95) {
    impacts.push({
      factor: `Temperature ${Math.round(temp)}°F`,
      effect: "Extreme heat — fatigue factor, especially for visiting teams. Watch for slow 4th quarters.",
      severity: "medium",
    });
  }

  // Precipitation
  if (precip >= 70) {
    impacts.push({
      factor: `${Math.round(precip)}% chance of precipitation`,
      effect: `${conditions} likely — slippery conditions favor run game, turnovers increase. Strong under lean.`,
      severity: "high",
    });
  } else if (precip >= 40) {
    impacts.push({
      factor: `${Math.round(precip)}% chance of precipitation`,
      effect: "Moderate precipitation risk — monitor closer to game time.",
      severity: "medium",
    });
  }

  if (impacts.length === 0) {
    impacts.push({
      factor: "Weather",
      effect: "Good conditions — no significant weather impact expected.",
      severity: "none",
    });
  }

  return impacts;
}
