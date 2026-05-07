/**
 * Integration tests for the higher-level tools (no DB required for most;
 * those that need DB skip gracefully when DATABASE_URL is unset).
 *
 * These tests don't hit external APIs — they exercise the math and shape of
 * outputs using mocked or trivially-true inputs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { calculateKelly } from "../dist/tools/betting/kelly.js";
import { buildParlay } from "../dist/tools/betting/parlay.js";
import { getRiskStatus } from "../dist/tools/learning/risk_status.js";

const noDb = !process.env.DATABASE_URL;

// ── Drawdown breaker ─────────────────────────────────────────────────────────

test("getRiskStatus: returns default sizing when DB unavailable", { skip: !noDb }, async () => {
  const r = await getRiskStatus();
  assert.equal(r.kelly_multiplier, 1);
  assert.equal(r.drawdown_band, "ok");
  assert.ok(r.notes.some((n) => /DATABASE_URL|history/.test(n)));
});

test("calculateKelly: drawdown_multiplier propagates into output (no DB → 1.0)", { skip: !noDb }, async () => {
  const r = await calculateKelly({
    bankroll: 1000,
    edge_percentage: 3,
    odds: -110,
    edge_is_no_vig: true,
    kelly_fraction: 0.25,
  });
  assert.equal(r.drawdown_multiplier, 1);
  assert.equal(r.drawdown_band, "ok");
  assert.equal(r.daily_limit_breached, false);
});

// ── Parlay SGP analysis ──────────────────────────────────────────────────────

test("SGP analysis: book quoting BIG juice → recommendation 'take_straight'", () => {
  // 2 same-game uncorrelated legs at -110/-110, fair_prob=0.5, fair joint=25%, fair dec=4.
  // Book quotes SGP at +180 (2.8 dec) → way under fair (3.6 with positive correlation
  // expected for ML+Over but here we use uncorrelated so independent fair holds).
  const r = buildParlay({
    sport: "nba",
    legs: [
      // Use prop+prop so correlation entry is "two_props_same_game" = 0.28
      { game: "Lakers vs Celtics", side: "Player A Over", book: "dk", odds: -110, type: "prop", fair_prob: 0.5 },
      { game: "Lakers vs Celtics", side: "Player B Over", book: "dk", odds: -110, type: "prop", fair_prob: 0.5 },
    ],
    book_sgp_american_odds: 180,
  });
  assert.ok(r.sgp_analysis);
  // Book is overcharging (juice positive) AND straight legs win → take_straight
  assert.ok(r.sgp_analysis.sgp_juice_pct > 0,
    `expected positive juice, got ${r.sgp_analysis.sgp_juice_pct}`);
  assert.ok(["take_straight", "skip"].includes(r.sgp_analysis.recommendation),
    `unexpected rec: ${r.sgp_analysis.recommendation}`);
});

test("SGP analysis: book quoting GENEROUS price → recommendation 'take_sgp'", () => {
  // 2 highly correlated same-game legs at -110/-110, fair_prob each 0.5.
  // With strong positive correlation, true joint > 25%, fair dec < 4.
  // Book quotes SGP at +600 (7.0 dec) → much higher than fair → +EV, take SGP.
  const r = buildParlay({
    sport: "nba",
    legs: [
      { game: "Lakers vs Celtics", side: "Lakers", book: "dk", odds: -150, type: "h2h", fair_prob: 0.6 },
      { game: "Lakers vs Celtics", side: "Over 220", book: "dk", odds: -110, type: "total", fair_prob: 0.5 },
    ],
    book_sgp_american_odds: 600,
  });
  assert.ok(r.sgp_analysis);
  // Book SGP price 7.0 vs fair < 1/0.39 ≈ 2.55 → book is generous, big +EV
  assert.equal(r.sgp_analysis.recommendation, "take_sgp");
});

// ── Parlay correlation correctness ───────────────────────────────────────────

test("Parlay covSum: all-correlated legs → true_joint > independent and ≤ min_marginal", () => {
  const r = buildParlay({
    sport: "nba",
    legs: [
      { game: "G1", side: "A", book: "dk", odds: -110, type: "prop", fair_prob: 0.5 },
      { game: "G1", side: "B", book: "dk", odds: -110, type: "prop", fair_prob: 0.5 },
    ],
  });
  assert.ok(r.true_combined_probability_pct > r.independent_true_probability_pct);
  assert.ok(r.true_combined_probability_pct <= 50.0001); // <= min marginal (50%)
});

test("Parlay: data_quality 'inferred' when no fair_prob nor opposing_odds", () => {
  const r = buildParlay({
    sport: "nba",
    legs: [
      { game: "G1", side: "A", book: "dk", odds: -110, type: "h2h" },
      { game: "G2", side: "C", book: "dk", odds: -110, type: "h2h" },
    ],
  });
  assert.equal(r.data_quality, "inferred");
  assert.equal(r.recommended, false, "inferred-data parlays should never be recommended");
});

// ── Kelly behavior ───────────────────────────────────────────────────────────

test("Kelly: fraction haircut when edge_is_no_vig is false", async () => {
  const k1 = await calculateKelly({
    bankroll: 1000, edge_percentage: 3, odds: -110, kelly_fraction: 0.25, edge_is_no_vig: true,
  });
  const k2 = await calculateKelly({
    bankroll: 1000, edge_percentage: 3, odds: -110, kelly_fraction: 0.25, edge_is_no_vig: false,
  });
  assert.ok(k2.kelly_fraction_used < k1.kelly_fraction_used);
  assert.ok(k2.recommendedBet < k1.recommendedBet);
});

test("Kelly: zero or negative edge → recommendedBet 0", async () => {
  const r = await calculateKelly({
    bankroll: 1000, edge_percentage: 0, odds: -110, edge_is_no_vig: true,
  });
  assert.equal(r.recommendedBet, 0);
});
