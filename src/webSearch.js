import { WEB_SEARCH_TIMEOUT_MS } from "./config.js";

export async function webSearch({ query, max_results = 5 }) {
  if (!query || typeof query !== "string") {
    return { ok: false, error: "query is required." };
  }

  const limit = Math.min(Math.max(Number(max_results) || 5, 1), 10);
  if (process.env.BRAVE_SEARCH_API_KEY) {
    return braveSearch(query, limit);
  }
  return duckDuckGoInstantAnswer(query, limit);
}

async function braveSearch(query, limit) {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(limit));

  const data = await fetchJson(url, {
    headers: {
      accept: "application/json",
      "x-subscription-token": process.env.BRAVE_SEARCH_API_KEY
    }
  });

  const results = (data.web?.results || []).slice(0, limit).map((item) => ({
    title: item.title || "(untitled)",
    url: item.url || "",
    snippet: stripHtml(item.description || "")
  }));

  return formatSearchResults(query, results, "Brave Search");
}

async function duckDuckGoInstantAnswer(query, limit) {
  const url = new URL("https://api.duckduckgo.com/");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("no_html", "1");
  url.searchParams.set("skip_disambig", "1");

  const data = await fetchJson(url);
  const results = [];

  if (data.AbstractURL || data.AbstractText) {
    results.push({
      title: data.Heading || query,
      url: data.AbstractURL || "",
      snippet: data.AbstractText || ""
    });
  }

  for (const item of flattenRelatedTopics(data.RelatedTopics || [])) {
    if (results.length >= limit) break;
    const title = item.Text?.split(" - ")[0] || item.FirstURL || "(untitled)";
    results.push({
      title,
      url: item.FirstURL || "",
      snippet: item.Text || ""
    });
  }

  return formatSearchResults(query, results.slice(0, limit), "DuckDuckGo Instant Answer");
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEB_SEARCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "user-agent": "mini-claude-code/0.2",
        ...(options.headers || {})
      }
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 500)}`);
    }
    return await res.json();
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`web search timed out after ${Math.round(WEB_SEARCH_TIMEOUT_MS / 1000)}s`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function flattenRelatedTopics(items) {
  const flattened = [];
  for (const item of items) {
    if (Array.isArray(item.Topics)) {
      flattened.push(...flattenRelatedTopics(item.Topics));
    } else {
      flattened.push(item);
    }
  }
  return flattened;
}

function formatSearchResults(query, results, provider) {
  if (results.length === 0) {
    return {
      ok: true,
      content: `Provider: ${provider}\nQuery: ${query}\n\nNo results found. For fuller web search, set BRAVE_SEARCH_API_KEY.`
    };
  }

  const lines = [
    `Provider: ${provider}`,
    `Query: ${query}`,
    "",
    ...results.map((result, index) => [
      `${index + 1}. ${result.title}`,
      result.url ? `   URL: ${result.url}` : "",
      result.snippet ? `   Snippet: ${result.snippet}` : ""
    ].filter(Boolean).join("\n"))
  ];

  return { ok: true, content: lines.join("\n") };
}

function stripHtml(text) {
  return text.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}
