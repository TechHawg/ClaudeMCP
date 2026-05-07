/**
 * CLI entry point for the prop-history backfill.
 *
 * Usage:
 *   railway run npm run backfill                  # default: NBA+MLB+NHL+NFL, 60 days back
 *   railway run npm run backfill -- --days=120
 *   railway run npm run backfill -- --sports=nba,nhl --days=30
 *   railway run npm run backfill -- --nfl-seasons=2024,2025
 *
 * Locally with DATABASE_URL exported:
 *   DATABASE_URL=postgres://... npm run backfill
 *
 * The script just calls the same runBackfill() the MCP tool calls, so behavior
 * is identical. Output is JSON so you can pipe it through jq.
 */

import { runBackfill } from "../services/backfill/index.js";
import { initializeSchema } from "../db/client.js";

interface CliArgs {
  sports?: string[];
  days_back?: number;
  nfl_seasons?: number[];
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};
  for (const a of argv) {
    if (a.startsWith("--sports=")) {
      out.sports = a.slice("--sports=".length).split(",").map((s) => s.trim()).filter(Boolean);
    } else if (a.startsWith("--days=")) {
      out.days_back = Number(a.slice("--days=".length));
    } else if (a.startsWith("--nfl-seasons=")) {
      out.nfl_seasons = a.slice("--nfl-seasons=".length).split(",").map((s) => Number(s.trim())).filter(Number.isFinite);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.error("[Backfill CLI] starting with args:", JSON.stringify(args));

  // Ensure schema exists. Idempotent.
  await initializeSchema();

  const result = await runBackfill(args);
  console.log(JSON.stringify(result, null, 2));

  if (result.results.some((r) => !r.ok)) {
    console.error("[Backfill CLI] one or more sport backfills reported errors — see results above");
    process.exit(2);
  }
}

main().catch((err) => {
  console.error("[Backfill CLI] fatal:", err);
  process.exit(1);
});
