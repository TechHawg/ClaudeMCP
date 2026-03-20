/**
 * Tavily API integration for search and URL extraction.
 * Free tier: 1,000 API calls/month.
 * Search: POST https://api.tavily.com/search
 * Extract: POST https://api.tavily.com/extract
 */

import axios from "axios";
import { formatApiError } from "../../utils/helpers.js";

export interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

export interface TavilySearchResponse {
  source: "tavily";
  results: TavilySearchResult[];
  answer?: string;
  query: string;
  cached_at?: string;
}

export interface TavilyExtractResponse {
  source: "tavily_extract";
  url: string;
  content: string;
  cached_at?: string;
}

/** Tavily web search */
export async function tavilySearch(
  query: string,
  options: {
    recency?: "day" | "week" | "any";
    maxResults?: number;
    includeAnswer?: boolean;
  } = {}
): Promise<TavilySearchResponse> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error(
      "TAVILY_API_KEY not set. Get a free key at https://tavily.com/"
    );
  }

  const body: Record<string, unknown> = {
    api_key: apiKey,
    query,
    max_results: options.maxResults ?? 10,
    include_answer: options.includeAnswer ?? false,
    search_depth: "advanced",
  };

  // Map recency to days parameter
  if (options.recency === "day") body.days = 1;
  else if (options.recency === "week") body.days = 7;

  try {
    const resp = await axios.post("https://api.tavily.com/search", body, {
      headers: { "Content-Type": "application/json" },
      timeout: 20000,
    });

    const results: TavilySearchResult[] = (resp.data?.results ?? []).map(
      (r: Record<string, unknown>) => ({
        title: String(r.title ?? ""),
        url: String(r.url ?? ""),
        content: String(r.content ?? ""),
        score: Number(r.score ?? 0),
      })
    );

    return {
      source: "tavily",
      results,
      answer: resp.data?.answer,
      query,
    };
  } catch (error) {
    throw new Error(formatApiError(error, "Tavily Search"));
  }
}

/** Tavily URL content extraction */
export async function tavilyExtract(
  url: string
): Promise<TavilyExtractResponse> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error(
      "TAVILY_API_KEY not set. Get a free key at https://tavily.com/"
    );
  }

  try {
    const resp = await axios.post(
      "https://api.tavily.com/extract",
      {
        api_key: apiKey,
        urls: [url],
      },
      {
        headers: { "Content-Type": "application/json" },
        timeout: 30000,
      }
    );

    const extracted = resp.data?.results?.[0];
    if (!extracted) {
      throw new Error(`No content extracted from ${url}`);
    }

    return {
      source: "tavily_extract",
      url,
      content: extracted.raw_content ?? extracted.content ?? "",
    };
  } catch (error) {
    throw new Error(formatApiError(error, "Tavily Extract"));
  }
}
