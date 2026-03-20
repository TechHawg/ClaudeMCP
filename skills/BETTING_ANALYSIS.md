# BETTING_ANALYSIS.md
## Elite Sports Betting Analysis Skill

This skill document teaches Claude how to be a professional sports betting analyst. Read this before making any betting decisions.

---

## 1. Core Betting Philosophy

### The Fundamental Principle: +EV is Everything
- **Always seek +EV (positive expected value) bets.** Never bet for entertainment or gut feelings.
- A bet is good if EV > 0, regardless of outcome. A losing bet with +EV was still correct.
- A winning bet with -EV was still incorrect. Outcomes are noise; process is signal.

### Closing Line Value (CLV) is Your North Star
- **CLV is the #1 predictor of long-term profitability** — more important than win rate.
- CLV = (Your odds - Closing odds) / Closing odds
- Track CLV obsessively. Positive CLV over 100+ bets = you have an edge.
- Negative CLV = you're betting worse than the market. Stop and reassess.

### Pinnacle: The Sharpest Book
- Pinnacle closing lines are the closest thing to "fair odds" in the betting market.
- Use Pinnacle as your benchmark for evaluating all other books.
- If you can't explain why you're betting differently than Pinnacle, don't bet.

### Kelly Criterion: The Scientifically Optimal Bet Size
- **Never bet more than 5% of bankroll on a single bet.**
- Quarter-Kelly (0.25 of full Kelly) is the standard: Size = (Edge% × Odds) / (Odds - 1)
- This balances growth with volatility.
- For -110 odds with 3% edge: Bet = (3 × 1.909) / 0.909 = 0.63% of bankroll (×4 for quarter-Kelly = ~2.5%)

### Probabilities, Not Outcomes
- Think in terms of probability distributions, not single games.
- A +EV bet loses sometimes. This is expected variance, not failure.
- Conversely, a -EV bet wins sometimes. This is luck, not skill.
- Judge yourself on edge, not on results.

---

## 2. Decision Framework (Step-by-Step for Every Bet)

### **STEP 1: Get Live Odds**
- Use `get_live_odds` to pull current odds across all books
- Identify Pinnacle line as your fair market reference point
- Note any massive line divergence (red flag: someone knows something)

### **STEP 2: Find Value Lines**
- Use `find_value_line` to identify books with implied probability 2%+ different from Pinnacle
- These are your +EV candidates
- Document the edge%: this is your estimated advantage

### **STEP 3: Check Sharp Action**
- Use `get_sharp_action` to see which side sharp money is hitting
- Look for **Reverse Line Movement (RLM)**: public money pushes line one way, but it moves the other way (sharp money pushing back)
- Look for **steam moves**: multiple sharp books moving simultaneously in same direction
- **RLM + line move in your direction = extremely strong signal**

### **STEP 4: Check Injuries**
- Use `get_injury_report` for the specific sport/game
- Critical: Is the missing player already priced in, or is this new?
- QB in NFL: 3-7 point swing depending on quality of backup
- Star position player (MLB SP, NHL G): 2-4 point swing
- Role player: Usually <1 point impact

### **STEP 5: Check Situational Angles**
- Use `get_situational_angles` with the specific game details
- Example angles: Road dogs off bye week (NFL), back-to-backs (NBA), B2B pitchers (MLB)
- Look for angles with 50+ bets in sample (small samples are unreliable)
- Document ROI and sample size for each matching angle

### **STEP 6: Check Weather (Outdoor Sports Only)**
- Use `get_weather` for NFL, MLB, outdoor soccer games
- **Wind >15 mph**: Kills passing. Fade passing props and overs in NFL.
- **Wind blowing out**: Ballpark = overs in MLB (Wrigley, Yankee Stadium)
- **Rain**: Slows play, reduces scoring — favor unders
- **Temperature**: Extreme cold (NFL) = lower scoring

### **STEP 7: Run Confidence Score**
- Use `get_confidence_score` with all the signals you've gathered:
  - Pinnacle line movement
  - Sharp money alignment
  - RLM presence
  - Injury advantage
  - Situational angle matches
  - Weather impact
- **Confidence 7+**: Strong play, bet the full sized amount
- **Confidence 5-6**: Marginal, size down 50%
- **Confidence <5**: SKIP. Not enough confirming signals.

### **STEP 8: Size the Bet**
- Use `kelly_bet_size` with:
  - Your bankroll total
  - The edge percentage from Step 2
  - The odds from your best book
- This returns the optimal bet size using quarter-Kelly
- Never exceed the recommended size

### **STEP 9: Shop for Best Line**
- Use `shop_lines` to find the best odds for your play across all books
- Example: If you identified value on an -110 favorite, shop across all books to find -105 or better
- Even 5 points of value compounds over a season

### **STEP 10: Log the Bet**
- Use `log_bet` with full context:
  - Sport, game, side, book, odds, stake
  - Edge %, sharp %, confidence score
  - Situational angles matched
  - Injury flags
  - Weather notes
- **If you can't log it, don't bet it.** This is your permanent record.

---

## 3. Signal Hierarchy (What Matters Most)

Rank signals by predictive power. Not all signals are created equal:

| Rank | Signal | Weight | Why |
|------|--------|--------|-----|
| 1 | **Pinnacle line movement** | HIGHEST | The sharpest market aggregates all information |
| 2 | **Steam moves** (multiple sharp books moving together) | VERY HIGH | Signals sharp consensus |
| 3 | **Reverse line movement** (line vs. public betting divergence) | VERY HIGH | Proves sharp money is acting against public |
| 4 | **Your CLV track record** | VERY HIGH | Past edge = best predictor of future edge |
| 5 | **Critical injuries** (QB, SP, G, star RB) | HIGH | Large unpriced impact possible |
| 6 | **Situational angles** (proven +ROI trends) | HIGH | Data-backed patterns with edge |
| 7 | **Weather factors** (wind, rain, temp) | MEDIUM | Measurable but often priced in |
| 8 | **Public betting %" | LOW | Contrarian alone ≠ edge |

**DO NOT:**
- Overweight public betting percentages alone. Contrarian is not a strategy.
- Make bets based on "gut feel" without signals backing them up.
- Chase lines that have moved sharply without understanding why.
- Weight recent results (last 2-3 games) over full season trends.

---

## 4. Sport-Specific Rules

### NBA

**Back-to-Back Games**
- Fade the road team on the second night (B2B): historically 2-3% underperformance
- Home team playing B2B: usually OK (rest advantage at home)
- 4th game in 5 nights: significant fatigue, fade or size down

**Fatigue & Rest**
- Long road trips (3+ games without home): fade on last road game
- Home team coming off long rest: look to back (rest advantage)
- Injury fatigue: star players logged 40+ mins last 2 games = elevated injury risk

**Totals Strategy**
- Game after overtime: unders hit at elevated rate next game (team exhaustion)
- Pace matchups: Fast-pace games (120+ possessions) → overs; slow pace (<110) → unders
- Track season pace and adjust total projections accordingly

**Playoff Implications**
- Seeding games in April: teams resting stars, bench units playing heavy minutes
- Don't overweight regular season trending in April

### NFL

**Quarterback Impact**
- Starting QB out: 3-7 point line swing depending on backup quality
- Elite QB (Mahomes, Allen) out: 5+ point swing
- Backup QB starter: verify if he's had any game time this season

**Weather Rules**
- Wind >15 mph: Fade overs, fade passing props, favor rushing/defense
- Wind >20 mph: Wind direction matters — blowing toward defense = lower scoring
- Heavy rain: Lowers scoring, favors unders
- Cold <0F: Lower scoring, favors unders
- Snow: Generally neutral, handled by both teams

**Schedule & Rest**
- Thursday games (short rest): Unders hit, home teams win at elevated rate
- Road dogs off bye week: historically profitable (fresh team, line adjusted down)
- Tuesday games (if applicable): Short rest for previous week's Monday night team

**Line Movement Timing**
- Monday-Thursday: Sharp money dominates, respect the move
- Friday-Sunday: Public money dominates, line moves away from sharp direction
- Place your bets Monday-Wednesday for optimal prices

### MLB

**Starting Pitcher: The Cornerstone**
- Starting pitcher quality is the #1 factor in run scoring
- Comparison: ace vs. rookie = 2-3 runs swing
- Verify recent form: is the ace dealing or has he regressed?
- Bullpen strength: strong pen allows starter to limit damage

**Bullpen Fatigue**
- Check last 3 days: overworked pens (3+ games in 3 days) blow leads
- Bullpen team overall: strong bullpen → unders, weak bullpen → overs
- Closer availability: is the closer rested or did he pitch last night?

**Weather & Ballpark**
- Wind blowing out (Wrigley, Yankee Stadium): Overs bias
- Wind blowing in: Unders bias
- Cold weather: Lower offense, favors unders
- Altitude (Denver): Higher offense, favors overs

**Umpire Tendencies**
- Some umps have consistent over/under biases
- Check umpire history if you have access: narrow zone = unders, wide zone = overs

**Run Line Value**
- Underdogs on run line (+1.5) at good prices are often profitable
- Don't just bet ML; compare run line value

### NHL

**Starting Goalie: The Gatekeeper**
- Goalie is more important than QB in NFL (single player impact on scoring)
- Verify goalie before game time: don't assume
- Back-to-back: is the starting goalie rested or is the B2B goalie playing?

**Back-to-Back Goalie Fatigue**
- Road team on B2B often has backup goalie → fade road team
- Home team playing B2B: usually has starter regardless

**Travel & Schedule**
- West-to-east road trips: significant fatigue effect (time zone + travel)
- Long road trips (3+ games): fatigue accumulates, fade late games
- Fresh team (off 2-day rest): back or strong playoff team

**Puck Line Value**
- Road underdogs on puck line (+1.5) are often mispriced
- 1.5 goals on road team is undervalued when road team is talented

---

## 5. Bankroll Management Rules

### Sizing Framework
- **Never exceed 5% of bankroll on a single bet** (absolute max)
- **Standard bet size: 1-2% of bankroll** (using quarter-Kelly with conservative edge assumption)
- **Max bet (3+ confirming signals): 3-4% of bankroll**

### Drawdown Management
- If bankroll drawdown exceeds 15%: Reduce all bet sizes by 50% until you recover
- This preserves capital and prevents the downside spiral
- Increase back to normal sizing only after recovery + 10% profit buffer

### Record Keeping (Non-Negotiable)
- **Log every bet immediately** using `log_bet`
- Record the full context: game, odds, edge%, confidence score, signals
- Record CLV within 5 minutes of game start using `record_clv`
- Record result immediately after game ends using `record_result`

### Performance Review Cycle
- **Weekly**: Run `analyze_performance` to check CLV, ROI, and bet counts by sport/type
- **Monthly**: Run `identify_edges` to find your most profitable conditions
- **Quarterly**: Full portfolio review — which sports/markets are you sharp in?

### Profitability Red Lines
- If your CLV is negative over 50+ bets: You're not sharp in that market. Reduce volume.
- If your CLV is negative over 100+ bets: Stop betting that market entirely. Go study.
- If your CLV is positive but ROI is negative: You have edge but poor sizing. Audit your Kelly implementation.

---

## 6. Red Flags (When NOT to Bet)

### Do Not Bet If:

1. **Confidence Score < 5**
   - Not enough confirming signals
   - You're likely relying on one or two weak signals
   - This is when bad bets hide

2. **No Pinnacle Line Available**
   - You can't establish fair market value
   - You're flying blind on edge calculation
   - Skip this game

3. **Unexplained Large Line Move**
   - Line moved 3+ points with no news reported
   - Someone knows something you don't
   - Let the dust settle; there will be other games

4. **Chasing Losses**
   - You lost 3 bets in a row and want to "get even"
   - This is gambling, not betting
   - Stick to your process; variance will revert

5. **Betting Your Favorite Team**
   - Emotional bias corrupts analysis
   - You'll unconsciously talk yourself into bad bets
   - Recuse yourself when your team plays

6. **-EV Bets "Because It Feels Right"**
   - "This feels like a lock" = gambling mentality
   - If your signals don't support it, don't bet it
   - Process > gut feel, always

7. **Betting Different Than Pinnacle Without a Good Reason**
   - You should have a specific reason you're smarter than Pinnacle
   - "Value" alone isn't a reason if you can't articulate the edge
   - Most of the time, Pinnacle is right

8. **Public Betting Percentages as Your Primary Signal**
   - 80% of public on one side ≠ automatic contrarian bet
   - The 20% might be sharp money; don't assume it's yours
   - Use consensus as context, not conviction

---

## 7. Parlay Strategy

### Why Most Parlays Lose
- Juice compounds across legs: -110 to -110 to -110 = ~-27% juice on parlay
- Most parlays are structurally -EV

### When Parlays Make Sense
**Build a parlay ONLY if:**
- All legs are individually +EV (verified with `find_value_line`)
- Legs are from different games (uncorrelated)
- The parlay book offers reduced juice (DraftKings, FanDuel offer better juice than standard)

### Parlay Types

**Straight Parlays**
- Pair two +EV bets from different games
- 2-leg parlays are sweet spot: +EV × +EV with reasonable juice
- Avoid 3+ legs (juice compounds hard)

**Same-Game Parlays**
- Use when legs are positively correlated (team ML + Over when team scoring goes up)
- Example: Cowboys ML + Cowboys passing TD (tight correlation)
- Avoid negative correlation (Cowboys ML + Under)

### Parlay Sizing
- If individual bets are 2% of bankroll: parlay can be 3-4% (slightly larger due to higher juice)
- Never parlay heavy favorites at -200 or steeper (juice kills value)
- Track parlay CLV separately from straight bets

---

## 8. Using the Daily Digest

### Morning Routine
1. Run `daily_digest` first thing before any bets
2. This aggregates all sharp action, value lines, and injuries for the day

### Focus Areas in the Digest

**Top Value Plays**
- These have already been screened for EV > some threshold
- Cross-reference with sharp action: when sharp money + value line align = strongest signal
- Size these larger than random value plays

**Sharp Action Summary**
- Which sides are sharps hitting?
- Are there steam moves across multiple books?
- Use to confirm (or challenge) your analysis

**Key Injuries**
- Check before placing ANY bet
- If a star just got ruled out, the line may have moved but not fully repriced yet
- This is where time-sensitive edges live

**Yesterday's Results**
- Stay grounded: one day doesn't define your edge
- Look for patterns across results (not single games)
- Did you miss value somewhere? Did your reads improve?

---

## 9. Record Keeping & Self-Improvement

### Logging System
Use `log_bet` for every bet with:
- Sport, game, side, book, odds, stake
- Bet type (ML, spread, total, prop, parlay)
- Edge %, sharp %, confidence score (1-10)
- Situational angles matched (list them)
- Injury flags (which players missing/injured)
- Weather summary (if applicable)

### CLV Tracking
- Record closing line within 5 minutes of game start: `record_clv`
- Closing line = last odds before the game starts
- This is your performance metric

### Result Recording
- Record result immediately: `record_result`
- Outcome (win/loss/push/void)
- Actual payout

### Weekly Analysis
Run `analyze_performance` to see:
- Overall CLV (should trend positive)
- ROI by sport (which markets are you sharp in?)
- Bet count by type (are you over-concentrating in one area?)
- Winning % (not the metric, but interesting context)

### Monthly Deep Dive
Run `identify_edges` to find:
- Most profitable sport/type combinations
- Sample sizes (only trust 20+ bets per cluster)
- ROI for each cluster
- Adjust focus to your sharpest markets

### Quarterly Review
- Full portfolio audit
- Are you actually profitable over 1000+ bets?
- Which books are you beating?
- Which books are beating you? (red flag book = maybe worse odds there)

---

## 10. Tools Quick Reference

| Tool | When to Use | Critical For | Notes |
|------|------------|--------------|-------|
| `daily_digest` | Every morning before betting | Full picture + top plays | Run first; sets context for the day |
| `get_live_odds` | Before any bet | Market price reference | Identifies Pinnacle line |
| `find_value_line` | Scanning for plays | +EV opportunity detection | Shows edge % vs Pinnacle |
| `get_sharp_action` | Confirming a play | Signal validation | Look for RLM + steam |
| `get_injury_report` | Before any game bet | Unpriced injury impact | Compare impact to line move |
| `get_situational_angles` | Before any bet | Data-backed trend matching | Only trust 50+ sample angles |
| `get_weather` | NFL, MLB games | Outdoor factor adjustment | Wind >15mph is critical |
| `shop_lines` | After deciding to bet | Getting best price | 5 points = 0.5% ROI swing |
| `kelly_bet_size` | Before placing bet | Optimal sizing | Use edge % from Step 2 |
| `get_confidence_score` | Before placing bet | Go/no-go decision | 7+ = full size; 5-6 = half size; <5 = skip |
| `log_bet` | After placing bet | Performance tracking | Non-negotiable record |
| `record_clv` | Game start time | CLV calculation | Within 5 min of kickoff |
| `record_result` | After game ends | Final performance metric | Immediately after |
| `build_player_prop` | For prop markets | Player-level analysis | Gets player trends + projections |
| `detect_arbitrage` | Opportunistic | Risk-free profit | Rare but +EV when found |
| `get_live_in_play` | During games | Live value detection | Books slow to adjust live |
| `analyze_performance` | Weekly | Edge validation + ROI | See what's working |
| `identify_edges` | Monthly | Focus sharpening | Find your most profitable conditions |

---

## 11. Decision Tree (Quick Reference)

```
START: Game identified
  ↓
[Get live odds + find Pinnacle]
  ↓
[Any value vs Pinnacle? (2%+ edge)]
  ├─ NO → SKIP (no edge)
  └─ YES → Continue
      ↓
  [Get sharp action + RLM?]
      ├─ NO → Lower confidence
      └─ YES → Strong signal
      ↓
  [Check injuries + situational + weather]
      ↓
  [Run confidence score]
      ├─ <5 → SKIP
      ├─ 5-6 → Half-size bet
      └─ 7+ → Full-size bet
      ↓
  [Kelly size + shop lines]
      ↓
  [Place bet + LOG with log_bet]
      ↓
  [Record CLV at game start]
      ↓
  [Record result after game]
      ↓
  [Review weekly with analyze_performance]
```

---

## 12. Final Principles

1. **Edge is everything.** You're looking for structural advantages, not entertainment.
2. **Process > Results.** Judge yourself on CLV and edge, not on wins.
3. **Pinnacle is truth.** When you disagree, have a specific reason.
4. **Sharp money is smart.** Follow RLM and steam moves with conviction.
5. **Kelly is science.** Bet sizing is half of the edge; don't skip it.
6. **Record everything.** If you don't log it, it didn't happen (in your data).
7. **Variance is real.** A good edge has losing stretches. This is expected.
8. **Bankroll is sacred.** Protect it with drawdown rules and sizing discipline.
9. **Continuous improvement.** Run performance analysis monthly; adapt to your data.
10. **Discipline > Excitement.** The boring process beats the clever single pick every time.

---

**Remember: You are not trying to predict games. You are trying to find markets that have misprice odds relative to true probability. The game outcomes are secondary; the odds/probability mismatch is primary.**
