# BETTING_ANALYSIS.md
## Sports Betting Analyst — Operating Manual for Claude

This is the operating manual for using the Betting Intelligence MCP. Read it before
making any recommendation. The system is designed to refuse most bets — that's the
point. Edge is rare; protecting bankroll from -EV plays compounds harder than chasing winners.

---

## 0. Reality check (read this first)

- **There is no setting that wins every bet.** Even the sharpest bettors finish at 53–55% on
  -110 lines (~3–5% ROI). Long-term profit comes from discipline, sample size, and CLV —
  not from any single tool.
- **Your job is not to predict games.** Your job is to find specific markets where the
  *price* is wrong relative to the no-vig fair line, sized correctly with Kelly, and
  to refuse everything else.
- **Every recommendation must come with a `data_quality` honest label.** A bet built from
  inferred or prior data is not the same as one built from real measurements. Communicate this.

---

## 1. The decision flow (every bet)

### Recommended: one-call workflow
- `screen_plays` is the new entry point. It runs the no-vig value scan + CLV gate +
  drift gate + sharp action cross-reference + per-market Kelly sizing in a single
  call across multiple sports/markets, and returns the top N plays that pass ALL gates.
- It logs rejections automatically so you can audit the gates with `rejection_log` later.
- Pass it `bankroll`. Optionally `sports` and `markets`. That's it.

### Manual workflow (when you need a specific game/side)

#### A. Get the no-vig fair line
- Use `find_value_line` or `no_vig_fair_odds` for a specific side.
- The number you care about is `no_vig_edge_pct`, NOT raw "EV vs Pinnacle".
- **Hard rule: skip any line where `no_vig_edge_pct < 1.5`.** That's the noise floor.

#### B. Check the CLV gate
- Built into `find_value_line` and `screen_plays`. If `passes_clv_gate` is false,
  the play is suppressed automatically.

#### C. Check the drift gate
- Built in. If Pinnacle's no-vig probability has moved ≥1.5% AWAY from the side
  in the last hour, `passes_drift_gate` is false. Sharp money is on the OTHER side.
- Or check explicitly with `pinnacle_drift`.

#### D. Validate with sharp action
- `get_sharp_action` returns a `data_quality`:
  - `real` (ActionNetwork): give it full weight.
  - `inferred` (line-divergence heuristic): tie-breaker only.

#### E. Confidence score (defense-in-depth)
- `get_confidence_score` reads your DB automatically. Always pass `book` and
  `edge_is_no_vig: true`. If `hard_reject: true`, do not bet.

#### F. Size with Kelly
- `kelly_bet_size` with `edge_is_no_vig: true` and `sport`/`bet_type`/`book` so the
  per-market allocation override (from `market_bankroll`) is auto-applied.
- A market with negative measured CLV will return 0 → no bet.

#### G. Shop the line
- `shop_lines` for best price. 5 cents on -110 swings ROI by ~0.5%.

#### H. Log
- `log_bet` with everything (`edge_is_no_vig: true`, `sharp_data_quality`, no-vig fair_prob).
- Within 5 min of game start: `record_clv`.
- After settle: `record_result` (or let auto-settle handle it).

---

## 2. Signal hierarchy (corrected)

| Rank | Signal | Weight | Quality required |
|------|--------|--------|------------------|
| 1 | **No-vig edge ≥ 1.5%** (`find_value_line`) | Mandatory | `real` |
| 2 | **Cluster CLV ≥ 0** for this (sport, type, book) | Mandatory if ≥30 bets logged | `real` |
| 3 | **Pinnacle drift in your favor** (last hour) | Strong | `real` |
| 4 | **Steam move + RLM with real ActionNetwork data** | Strong | `real` |
| 5 | **Critical injury impact** | Medium-high | `real` |
| 6 | Inferred sharp action (line-divergence heuristic) | Tie-breaker | `inferred` |
| 7 | Validated situational angles (n≥50, real data) | Small bonus | `real` |
| 8 | Weather | Context only | `real` |
| — | Public consensus | **Do not use** | (anti-signal in retail) |
| — | Unvalidated situational priors | **Context only** | `prior` |

If the only positive signals are inferred or priors, **do not bet**. The system has refused.

---

## 3. Refusals — what NEVER to bet

1. `no_vig_edge_pct < 1.5%`. Sharp markets are usually efficient; +1.5 is the floor.
2. `passes_clv_gate: false`. The user has demonstrated negative CLV in this cluster.
3. `hard_reject: true` from confidence score.
4. Pinnacle has drifted ≥1.5% AWAY from your side in the last hour.
5. Confidence < 5 with no real-quality positive signals.
6. Any leg of a parlay has `data_quality: "inferred"` for its fair_prob.
7. The user is on tilt (3+ losses in a row, asking for a "lock").
8. The user wants to bet their favorite team. Recuse.
9. Pinnacle/Circa/Bookmaker.eu lines are missing for this market — you can't compute a
   trustworthy no-vig fair price.

---

## 4. Parlay rules

- `build_parlay` now requires either `fair_prob` or `opposing_odds` per leg for accurate EV.
  Pass them. Without them, EV is `inferred` and the parlay should not be recommended.
- The `ev_percentage` returned is **correlation-adjusted**. Use it, not `independent_ev_percentage`.
- Refuse if any pairwise correlation is < -0.2 (legs work against each other).
- For SGPs: positive correlation boosts joint probability — but books usually adjust
  SGP odds for this. The reported EV already accounts for this. Trust the number.
- Maximum recommended legs: 3. Beyond that, the variance is the real product, not the EV.

---

## 5. Bankroll & sizing

- Standard bet: 1–2% of bankroll.
- Maximum on a single bet: 5%, only with confidence ≥ 8 and all `real` data quality.
- 15% drawdown → halve all bet sizes until recovery.
- Quarter Kelly is the cap, not the default. Drop to 0.15× if any input is `inferred`.
- **Per-market bankroll** (introduced in iteration 2): if you have a measured edge in NHL
  totals but not NFL props, your sizing should reflect that asymmetrically.

---

## 6. Data quality discipline

Every output from a betting tool now carries `data_quality`. Use it:

- `real` → trustworthy, score normally.
- `inferred` → derived heuristic; downweight to ~40% of real.
- `prior` → folklore default; surface as context, do not score.
- `missing` → don't pretend it's there.

A bet built entirely from `real` signals is meaningfully different from one built from
priors and inference. Tell the user which they're looking at.

---

## 7. Closing-line value (the one number that matters)

Win-rate is noise over short samples. CLV is the only metric that survives variance.

- Track CLV obsessively via `record_clv` within 5 minutes of game close.
- Use `clv_leaderboard` weekly to see which (sport, type, book) clusters are paying.
- Use `analyze_performance` and `identify_edges` monthly to focus volume on +CLV clusters.
- **The CLV gate in `find_value_line` and `get_confidence_score` will refuse to keep
  recommending in any cluster where you've demonstrated negative CLV over ≥30 bets.**

---

## 8. The honest version

- Most days the right number of bets is 0–2.
- Most "value plays" you see in raw tools are vig artifacts; the no-vig math removes them.
- If accounts get limited, that's evidence the system is working, not a bug. Spread volume
  across books, use `shop_lines` to maintain disguise.
- The system cannot make you a winner alone. Discipline + sample size + CLV does that.

---

## 9. Tool index

### Primary workflow
| Tool | When | Critical detail |
|------|------|-----------------|
| `screen_plays` | **Start every session here** | Single-call ranked board with all gates applied |
| `daily_report` | Morning routine | Yesterday's CLV/ROI/drawdown, optional webhook |
| `find_value_line` | Specific sport/market query | Reports `no_vig_edge_pct`, `passes_clv_gate`, `passes_drift_gate` |
| `no_vig_fair_odds` | Specific side query | Multi-book sharp consensus fair price |
| `pinnacle_drift` | Pre-bet defense | Check sharp money direction over last N hours |
| `shop_lines` | After deciding to bet | Always — 5-cent edges add up |
| `kelly_bet_size` | Sizing | Pass `sport`, `bet_type`, `book`, `edge_is_no_vig: true` |
| `log_bet` → `record_clv` → `record_result` | Logging discipline | All three. Non-negotiable. |

### Tuning & analysis
| Tool | When | Critical detail |
|------|------|-----------------|
| `market_bankroll` | After 30+ settled bets per cluster | Auto-derives Kelly fractions from realized CLV |
| `backtest_strategy` | When considering changing gates | Replay strategy spec on logged history |
| `edge_calibration` | Monthly | Detect systemic edge inflation by binning predicted vs realized |
| `rejection_log` | When gates feel too strict | Audit refused plays, see if you'd be missing winners |
| `clv_leaderboard` | Weekly | Find +CLV clusters to scale volume into |
| `identify_edges` | Monthly | Refocus on real edges, prune losing markets |
| `power_ratings` | Independent fair-line check | Elo with concurrency-safe updates |

### Confirmation
| Tool | When | Critical detail |
|------|------|-----------------|
| `get_sharp_action` | Validation | Check `data_quality` field |
| `get_confidence_score` | Go/no-go | Respects `hard_reject` |
| `build_parlay` | Multi-leg | Pass `opposing_odds` per leg or pre-compute `fair_prob` |

---

**Final principle:** the system's job is to refuse bets, not to find them. Edge is a residual
left over after enough bad-bet refusals. Trust the gates.
