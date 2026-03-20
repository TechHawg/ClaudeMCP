/**
 * Webhook Alerts Tool
 * Configures threshold-based alerts that fire webhooks when conditions are met.
 * Supports Discord, Slack, and generic webhook URLs.
 * Alerts are stored in Postgres and checked when odds are fetched.
 */

import axios from "axios";
import { isDatabaseConfigured, query, queryOne } from "../../db/client.js";
import { getLiveOdds } from "./odds.js";
import { findValueLines } from "./value.js";
import { detectArbitrage } from "./arb.js";
import { resolveSportKey } from "../../utils/helpers.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface AlertConfig {
  id?: number;
  name: string;
  sport: string;
  alert_type: string; // "value", "arb", "steam", "odds_change"
  threshold: number; // e.g., 5 for 5% EV, 2 for 2% arb profit
  webhook_url: string;
  webhook_type: string; // "discord", "slack", "generic"
  active: boolean;
  created_at?: string;
  last_triggered?: string;
}

interface AlertResult {
  alerts?: AlertConfig[];
  created?: AlertConfig;
  triggered?: TriggeredAlert[];
  message: string;
}

interface TriggeredAlert {
  alert_name: string;
  alert_type: string;
  details: string;
  webhook_sent: boolean;
}

// ── Implementation ───────────────────────────────────────────────────────────

export async function manageAlerts(params: {
  action: string; // "create", "list", "delete", "check", "test"
  name?: string;
  sport?: string;
  alert_type?: string;
  threshold?: number;
  webhook_url?: string;
  webhook_type?: string;
  alert_id?: number;
}): Promise<AlertResult> {
  if (!isDatabaseConfigured()) {
    throw new Error(
      "Database not configured. Alerts require DATABASE_URL for persistence."
    );
  }

  switch (params.action) {
    case "create":
      return createAlert(params);
    case "list":
      return listAlerts(params.sport);
    case "delete":
      return deleteAlert(params.alert_id);
    case "check":
      return checkAlerts(params.sport);
    case "test":
      return testWebhook(params.webhook_url, params.webhook_type);
    default:
      throw new Error(
        `Unknown action "${params.action}". Valid: create, list, delete, check, test`
      );
  }
}

// ── Create alert ─────────────────────────────────────────────────────────────

async function createAlert(params: {
  name?: string;
  sport?: string;
  alert_type?: string;
  threshold?: number;
  webhook_url?: string;
  webhook_type?: string;
}): Promise<AlertResult> {
  if (!params.name) throw new Error("Alert name is required.");
  if (!params.sport) throw new Error("Sport is required.");
  if (!params.alert_type) throw new Error("Alert type is required (value, arb, steam, odds_change).");
  if (params.threshold === undefined) throw new Error("Threshold is required.");
  if (!params.webhook_url) throw new Error("Webhook URL is required.");

  const webhookType = params.webhook_type ?? detectWebhookType(params.webhook_url);

  await query(
    `INSERT INTO alerts (name, sport, alert_type, threshold, webhook_url, webhook_type, active)
     VALUES ($1, $2, $3, $4, $5, $6, true)`,
    [params.name, params.sport, params.alert_type, params.threshold, params.webhook_url, webhookType]
  );

  const created: AlertConfig = {
    name: params.name,
    sport: params.sport,
    alert_type: params.alert_type,
    threshold: params.threshold,
    webhook_url: params.webhook_url,
    webhook_type: webhookType,
    active: true,
  };

  return {
    created,
    message: `Alert "${params.name}" created. Will fire when ${params.alert_type} >= ${params.threshold}% for ${params.sport}.`,
  };
}

// ── List alerts ──────────────────────────────────────────────────────────────

async function listAlerts(sport?: string): Promise<AlertResult> {
  let sql = `SELECT id, name, sport, alert_type, threshold, webhook_url, webhook_type, active, created_at::text, last_triggered::text
             FROM alerts`;
  const params: unknown[] = [];
  if (sport) {
    sql += ` WHERE sport = $1`;
    params.push(sport);
  }
  sql += ` ORDER BY created_at DESC`;

  const rows = await query<AlertConfig>(sql, params);
  return {
    alerts: rows,
    message: `${rows.length} alert(s) configured.`,
  };
}

// ── Delete alert ─────────────────────────────────────────────────────────────

async function deleteAlert(alertId?: number): Promise<AlertResult> {
  if (!alertId) throw new Error("Alert ID is required for deletion.");
  await query(`DELETE FROM alerts WHERE id = $1`, [alertId]);
  return { message: `Alert #${alertId} deleted.` };
}

// ── Check all alerts against current odds ────────────────────────────────────

async function checkAlerts(sportFilter?: string): Promise<AlertResult> {
  let sql = `SELECT id, name, sport, alert_type, threshold, webhook_url, webhook_type
             FROM alerts WHERE active = true`;
  const params: unknown[] = [];
  if (sportFilter) {
    sql += ` AND sport = $1`;
    params.push(sportFilter);
  }

  const alerts = await query<AlertConfig & { id: number }>(sql, params);
  if (alerts.length === 0) {
    return { triggered: [], message: "No active alerts to check." };
  }

  const triggered: TriggeredAlert[] = [];

  for (const alert of alerts) {
    try {
      let details: string | null = null;

      if (alert.alert_type === "value") {
        const value = await findValueLines({
          sport: alert.sport,
          bet_type: "h2h",
        });
        const valueLines = (value as unknown as Record<string, unknown>).value_lines as Array<Record<string, unknown>> | undefined;
        const hits = (valueLines ?? []).filter(
          (v) => ((v.ev_percentage as number) ?? 0) >= alert.threshold
        );
        if (hits.length > 0) {
          details = `${hits.length} value line(s) >= ${alert.threshold}% EV. Top: ${JSON.stringify(hits[0])}`;
        }
      }

      if (alert.alert_type === "arb") {
        const arbs = await detectArbitrage({ sport: alert.sport });
        const arbResult = arbs as unknown as Record<string, unknown>;
        const arbOpps = arbResult.arbitrage_opportunities as Array<Record<string, unknown>> | undefined;
        const hits = (arbOpps ?? []).filter(
          (a) => ((a.profit_pct as number) ?? 0) >= alert.threshold
        );
        if (hits.length > 0) {
          details = `${hits.length} arb(s) >= ${alert.threshold}% profit. Top: ${JSON.stringify(hits[0])}`;
        }
      }

      if (details) {
        const webhookSent = await sendWebhook(
          alert.webhook_url,
          alert.webhook_type,
          alert.name,
          details
        );

        triggered.push({
          alert_name: alert.name,
          alert_type: alert.alert_type,
          details,
          webhook_sent: webhookSent,
        });

        // Update last_triggered
        await query(
          `UPDATE alerts SET last_triggered = NOW() WHERE id = $1`,
          [alert.id]
        );
      }
    } catch (error) {
      console.error(`[Alerts] Failed to check alert "${alert.name}":`, error);
    }
  }

  return {
    triggered,
    message:
      triggered.length > 0
        ? `${triggered.length} alert(s) triggered and webhook(s) sent.`
        : `Checked ${alerts.length} alert(s) — no thresholds exceeded.`,
  };
}

// ── Test webhook ─────────────────────────────────────────────────────────────

async function testWebhook(
  url?: string,
  type?: string
): Promise<AlertResult> {
  if (!url) throw new Error("Webhook URL is required for testing.");
  const webhookType = type ?? detectWebhookType(url);

  const sent = await sendWebhook(
    url,
    webhookType,
    "Test Alert",
    "This is a test from your Betting MCP Server. If you see this, webhooks are working!"
  );

  return {
    message: sent
      ? "Test webhook sent successfully."
      : "Failed to send test webhook. Check the URL and try again.",
  };
}

// ── Send webhook ─────────────────────────────────────────────────────────────

async function sendWebhook(
  url: string,
  type: string,
  alertName: string,
  details: string
): Promise<boolean> {
  try {
    let payload: Record<string, unknown>;

    if (type === "discord") {
      payload = {
        embeds: [
          {
            title: `🚨 ${alertName}`,
            description: details,
            color: 0xff6600,
            timestamp: new Date().toISOString(),
            footer: { text: "Betting MCP Server" },
          },
        ],
      };
    } else if (type === "slack") {
      payload = {
        blocks: [
          {
            type: "header",
            text: { type: "plain_text", text: `🚨 ${alertName}` },
          },
          {
            type: "section",
            text: { type: "mrkdwn", text: details },
          },
        ],
      };
    } else {
      payload = {
        alert_name: alertName,
        details,
        timestamp: new Date().toISOString(),
        source: "betting-mcp-server",
      };
    }

    await axios.post(url, payload, { timeout: 10000 });
    return true;
  } catch (error) {
    console.error(`[Webhook] Failed to send to ${url}:`, error);
    return false;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function detectWebhookType(url: string): string {
  if (url.includes("discord.com/api/webhooks")) return "discord";
  if (url.includes("hooks.slack.com")) return "slack";
  return "generic";
}
