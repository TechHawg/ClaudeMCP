/**
 * Perplexity Sonar API integration.
 * Models: sonar (lightweight), sonar-pro (deep retrieval).
 * Endpoint: POST https://api.perplexity.ai/chat/completions
 * Pricing: ~$1/1000 queries (sonar), ~$5/1000 (sonar-pro)
 */

import axios from "axios";
import { formatApiError } from "../../utils/helpers.js";

export interface PerplexityCitation {
  url: string;
  title?: string;
}

export interface PerplexityResult {
  source: "perplexity";
  answer: string;
  citations: PerplexityCitation[];
  model: string;
  query: string;
  cached_at?: string;
}

export async function perplexitySearch(
  query: string,
  options: { model?: "sonar" | "sonar-pro" } = {}
): Promise<PerplexityResult> {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) {
    throw new Error(
      "PERPLEXITY_API_KEY not set. Get access at https://www.perplexity.ai/api-platform"
    );
  }

  const model = options.model ?? "sonar-pro";

  try {
    const resp = await axios.post(
      "https://api.perplexity.ai/chat/completions",
      {
        model,
        messages: [
          {
            role: "system",
            content:
              "You are a research assistant. Provide concise, factual answers with relevant data points. Focus on the most recent and reliable information.",
          },
          { role: "user", content: query },
        ],
        max_tokens: 2000,
        return_citations: true,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      }
    );

    const choice = resp.data?.choices?.[0];
    const answer = choice?.message?.content ?? "No answer returned";
    const rawCitations = resp.data?.citations ?? [];
    const citations: PerplexityCitation[] = rawCitations.map(
      (c: string | { url: string; title?: string }) =>
        typeof c === "string" ? { url: c } : c
    );

    return { source: "perplexity", answer, citations, model, query };
  } catch (error) {
    throw new Error(formatApiError(error, "Perplexity"));
  }
}
