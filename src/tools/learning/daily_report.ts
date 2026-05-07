/**
 * Daily report — yesterday's CLV/ROI/drawdown summary.
 * Optional webhook delivery (Discord/Slack/generic) for hands-off operation.
 */

import axios from "axios";
import { isDatabaseConfigured, query } from "../../db/client.js";

export interface DailyReport {
  date: string;
  bets_settled: number;
  wins: number;
  losses: number;
  pushes: number;
  total_stake: number;
  total_payout: number;
  profit: number;
  roi_pct: number;
  avg_clv_pct: number;
  avg_no_vig_clv_pct: number | null;
  by_sport: Array<{
    sport: string;
    bets: number;
    profit: number;
    roi_pct: number;
    avg_no_vig_clv_pct: number | null;
  }>;
  rejections: Record<string, number>;
  open_bets: number;
  notes: string[];
}

export async function getDailyReport(params: {
  date?: string;
  webhook_url?: string;
}): Promise<DailyReport | { error: string }> {
  if (!isDatabaseConfigured()) {
    return { error: "DATABASE_URL not set — daily report requires Postgres." };
  }

  const date = params.date ?? new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
  const notes: string[] = [];

  // Settled bets for the day
  const rows = await query<{
    sport: string;
    outcome: "win" | "loss" | "push";
    stake: string | number;
    payout: string | number | null;
    clv: string | number | null;
    no_vig_clv: string | number | null;
  }>(
    `SELECT sport, outcome, stake, payout, clv, no_vig_clv
       FROM bets
      WHERE outcome IN ('win','loss','push')
        AND DATE(created_at) = $1`,
    [date]
  );

  let wins = 0, losses = 0, pushes = 0;
  let totalStake = 0, totalPayout = 0;
  let clvSum = 0, clvCount = 0;
  let noVigClvSum = 0, noVigClvCount = 0;
  const bySportMap = new Map<string, { bets: number; profit: number; stake: number; noVigClvSum: number; noVigClvCount: number }>();

  for (const r of rows) {
    const stake = Number(r.stake);
    const payout = r.payout == null ? 0 : Number(r.payout);
    totalStake += stake;
    totalPayout += payout;
    if (r.outcome === "win") wins++;
    else if (r.outcome === "loss") losses++;
    else if (r.outcome === "push") pushes++;
    if (r.clv != null) { clvSum += Number(r.clv); clvCount++; }
    if (r.no_vig_clv != null) { noVigClvSum += Number(r.no_vig_clv); noVigClvCount++; }

    if (!bySportMap.has(r.sport)) bySportMap.set(r.sport, { bets: 0, profit: 0, stake: 0, noVigClvSum: 0, noVigClvCount: 0 });
    const ent = bySportMap.get(r.sport)!;
    ent.bets++;
    ent.profit += payout - stake;
    ent.stake += stake;
    if (r.no_vig_clv != null) { ent.noVigClvSum += Number(r.no_vig_clv); ent.noVigClvCount++; }
  }

  const profit = totalPayout - totalStake;
  const roi = totalStake > 0 ? (profit / totalStake) * 100 : 0;

  // Open bets
  const openRows = await query<{ n: string | number }>(
    `SELECT COUNT(*) AS n FROM bets WHERE outcome IS NULL`
  );
  const openBets = Number(openRows[0]?.n ?? 0);

  // Rejections summary for the day
  const rejRows = await query<{ reason: string; n: string | number }>(
    `SELECT reason, COUNT(*) AS n FROM bet_rejections WHERE DATE(rejected_at) = $1 GROUP BY reason`,
    [date]
  );
  const rejections: Record<string, number> = {};
  for (const r of rejRows) rejections[r.reason] = Number(r.n);

  if (rows.length === 0) notes.push(`No bets settled for ${date}.`);

  const report: DailyReport = {
    date,
    bets_settled: rows.length,
    wins,
    losses,
    pushes,
    total_stake: Number(totalStake.toFixed(2)),
    total_payout: Number(totalPayout.toFixed(2)),
    profit: Number(profit.toFixed(2)),
    roi_pct: Number(roi.toFixed(2)),
    avg_clv_pct: clvCount > 0 ? Number((clvSum / clvCount).toFixed(3)) : 0,
    avg_no_vig_clv_pct: noVigClvCount > 0 ? Number((noVigClvSum / noVigClvCount).toFixed(3)) : null,
    by_sport: [...bySportMap.entries()].map(([sport, e]) => ({
      sport,
      bets: e.bets,
      profit: Number(e.profit.toFixed(2)),
      roi_pct: e.stake > 0 ? Number(((e.profit / e.stake) * 100).toFixed(2)) : 0,
      avg_no_vig_clv_pct: e.noVigClvCount > 0 ? Number((e.noVigClvSum / e.noVigClvCount).toFixed(3)) : null,
    })),
    rejections,
    open_bets: openBets,
    notes,
  };

  // Optional webhook delivery
  const webhookUrl = params.webhook_url ?? process.env.DAILY_REPORT_WEBHOOK_URL;
  if (webhookUrl) {
    try {
      await postWebhook(webhookUrl, report);
    } catch (err) {
      report.notes.push(`Webhook delivery failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return report;
}

async function postWebhook(url: string, report: DailyReport): Promise<void> {
  const isDiscord = url.includes("discord.com/api/webhooks");
  const isSlack = url.includes("hooks.slack.com");

  const summary = formatTextSummary(report);

  if (isDiscord) {
    await axios.post(url, {
      content: summary,
    }, { timeout: 10000 });
  } else if (isSlack) {
    await axios.post(url, { text: summary }, { timeout: 10000 });
  } else {
    await axios.post(url, report, { timeout: 10000 });
  }
}

function formatTextSummary(r: DailyReport): string {
  const sign = r.profit >= 0 ? "+" : "";
  const lines = [
    `**Daily Report — ${r.date}**`,
    `Settled: ${r.bets_settled} (${r.wins}W / ${r.losses}L / ${r.pushes}P)`,
    `P/L: ${sign}$${r.profit.toFixed(2)} (${sign}${r.roi_pct.toFixed(2)}% ROI)`,
    `Avg no-vig CLV: ${r.avg_no_vig_clv_pct != null ? r.avg_no_vig_clv_pct.toFixed(2) + "%" : "n/a"} | Juiced CLV: ${r.avg_clv_pct.toFixed(2)}%`,
    `Open bets: ${r.open_bets}`,
  ];
  if (r.by_sport.length > 0) {
    lines.push("By sport:");
    for (const s of r.by_sport) {
      lines.push(`  - ${s.sport}: ${s.bets} bets, ${s.profit >= 0 ? "+" : ""}$${s.profit.toFixed(2)} (${s.roi_pct.toFixed(1)}% ROI)`);
    }
  }
  if (Object.keys(r.rejections).length > 0) {
    lines.push("Rejections:");
    for (const [reason, count] of Object.entries(r.rejections)) {
      lines.push(`  - ${reason}: ${count}`);
    }
  }
  return lines.join("\n");
}
