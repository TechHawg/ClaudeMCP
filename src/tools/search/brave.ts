/**
 * Brave Search API integration.
 * Free tier: 2,000 queries/month.
 * Endpoint: GET https://api.search.brave.com/res/v1/web/search
 */

import axios from "axios";
import { formatApiError } from "../../utils/helpers.js";

export interface BraveResult {
  title: string;
  url: string;
  snippet: string;
  age?: string;
}

export interface BraveSearchResponse {
  source: "brave";
  results: BraveResult[];
  query: string;
  cached_at?: string;
}

export async function braveSearch(
  query: string,
  options: { recency?: "day" | "week" | "any"; count?: number } = {}
): Promise<BraveSearchResponse> {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "BRAVE_API_KEY not set. Get a free key at https://brave.com/search/api/"
    );
  }

  const params: Record<string, string | number> = {
    q: query,
    count: options.count ?? 10,
    text_decorations: "false",
    search_lang: "en",
  };

  // Map recency to freshness parameter
  if (options.recency === "day") params.freshness = "pd";
  else if (options.recency === "week") params.freshness = "pw";

  try {
    const resp = await axios.get(
      "https://api.search.brave.com/res/v1/web/search",
      {
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip",
          "X-Subscription-Token": apiKey,
        },
        params,
        timeout: 15000,
      }
    );

    const webResults = resp.data?.web?.results ?? [];
    const results: BraveResult[] = webResults.map(
      (r: Record<string, string>) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: r.description ?? "",
        age: r.age,
      })
    );

    return { source: "brave", results, query };
  } catch (error) {
    throw new Error(formatApiError(error, "Brave Search"));
  }
}
