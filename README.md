# Betting Intelligence MCP Server

A production-ready remote MCP server that provides **17 tools** across three categories: unified web search, sports betting intelligence, and a self-improving learning layer. Built with TypeScript, deployed on Railway, and accessible from Claude on any device via Streamable HTTP.

## Quick Start

### 1. Clone & Install

```bash
git clone <your-repo-url>
cd betting-mcp-server
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Fill in your API keys (see API Keys section below)
```

### 3. Build & Run Locally

```bash
npm run build
TRANSPORT=http PORT=3000 npm start
```

### 4. Deploy to Railway

```bash
# Push to GitHub, then connect the repo in Railway dashboard
# Or use Railway CLI:
railway login
railway init
railway up
```

Railway will auto-detect the `railway.toml` config and deploy.

### 5. Connect to Claude

Once deployed, add as a custom connector in Claude:

**Settings → Connectors → + → Custom** → paste your Railway URL:

```
https://your-app.railway.app/mcp
```

## Tool Reference

### Search Tools (1 tool)

| Tool | Description |
|------|-------------|
| `unified_search` | Search via Brave (fast), Perplexity Sonar Pro (deep), or Tavily (crawl). Parallel mode merges all three. |

### Betting Intelligence Tools (10 tools)

| Tool | Description |
|------|-------------|
| `get_live_odds` | Live odds from all books via The Odds API. Pinnacle sharp reference. 60s cache. |
| `find_value_line` | Compare book lines vs Pinnacle. Flags >2% implied probability gaps as value. |
| `build_player_prop` | Player prop cards with SportsRadar stats, matchup projections, hit rates. |
| `build_parlay` | Multi-leg parlay builder with Pearson correlation checking and EV analysis. |
| `detect_arbitrage` | Scans all books for guaranteed-profit arbs and middle opportunities. |
| `kelly_bet_size` | Kelly Criterion sizing with precise Decimal.js arithmetic. |
| `get_sharp_action` | Sharp money %, public %, reverse line movement, steam move detection. |
| `get_weather` | Stadium weather forecast with betting impact assessment (wind, temp, precip). |
| `get_injury_report` | Injury feed from Rotowire/SportsRadar with estimated line impact per player. |
| `get_situational_angles` | Database of 20+ proven angles (NFL bye weeks, NBA B2Bs, MLB bullpen, NHL fatigue). |

### Learning Tools (6 tools)

| Tool | Description |
|------|-------------|
| `log_bet` | Log bets with full context tags (sharp %, weather, injuries, angles, confidence). |
| `record_clv` | Track closing line value — the #1 metric for sharp betting skill. |
| `record_result` | Record win/loss/push outcomes and payouts. |
| `analyze_performance` | Full performance breakdown by sport, type, book. Surfaces profitable patterns. |
| `identify_edges` | Clusters bet history to find your top-5 highest-ROI condition combos. |
| `get_confidence_score` | Scores proposed bets 1-10 based on confirming signal count and strength. |

## API Keys Required

| API | Free Tier | Env Variable |
|-----|-----------|-------------|
| [The Odds API](https://the-odds-api.com/) | 500 req/month | `THE_ODDS_API_KEY` |
| [Brave Search](https://brave.com/search/api/) | 2,000 queries/month | `BRAVE_API_KEY` |
| [Tavily](https://tavily.com/) | 1,000 calls/month | `TAVILY_API_KEY` |
| [Perplexity](https://www.perplexity.ai/api-platform) | Pay-per-query (~$1-5/1K) | `PERPLEXITY_API_KEY` |
| [SportsRadar](https://developer.sportradar.com/) | 1,000 calls/month trial | `SPORTRADAR_API_KEY` |
| [OpenWeatherMap](https://openweathermap.org/api) | 1,000 calls/day | `OPENWEATHER_API_KEY` |
| [Rotowire](https://rotowire.com/) | Paid (contact for pricing) | `ROTOWIRE_API_KEY` |
| [ActionNetwork](https://actionnetwork.com/) | Premium endpoints paid | `ACTION_NETWORK_API_KEY` |
| PostgreSQL | Railway addon (free tier available) | `DATABASE_URL` |

Tools degrade gracefully — if an API key is missing, the tool returns a helpful error message explaining what's needed.

## Architecture

```
Client (Claude) ──POST /mcp──▶ Express ──▶ StreamableHTTPServerTransport ──▶ McpServer
                                  │
                                  ├── /health (GET) — health check
                                  └── /mcp (POST) — MCP endpoint
                                        │
                                        ├── Search Tools ─── Brave / Perplexity / Tavily
                                        ├── Betting Tools ── The Odds API / SportsRadar / OpenWeather
                                        └── Learning Tools ── PostgreSQL
```

- **Transport**: Streamable HTTP (stateless JSON mode) — no SSE, no sessions
- **Caching**: In-memory odds cache (60s TTL) + search cache (5min TTL)
- **Precision**: All monetary/odds calculations use Decimal.js — no floating point errors
- **Database**: PostgreSQL for bet logging, CLV tracking, situational angles, performance analysis

## Sample Test Prompt

After connecting, try this in Claude to verify everything works:

> "I want to analyze tonight's NFL games. Pull live odds for NFL, find any value lines vs Pinnacle, check sharp money action on the Chiefs game, get weather for Arrowhead Stadium for today at 7pm CT, pull injury reports for both teams, check situational angles, and then give me a confidence score on the best value play you find. Use quarter Kelly on a $5,000 bankroll."

## Development

```bash
npm run dev      # Watch mode with tsx
npm run build    # TypeScript compilation
npm start        # Run compiled server
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check — returns server status + tool count |
| `POST` | `/mcp` | MCP endpoint — Streamable HTTP transport |
| `DELETE` | `/mcp` | Session cleanup |

## License

MIT
