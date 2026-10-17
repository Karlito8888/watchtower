// Browser-side CoinGecko client. No API key: each visitor spends their own IP quota
// (public API, roughly 10 to 30 calls per minute). Responses are cached in sessionStorage
// so navigating back and forth never re-spends a call within the TTL.

const BASE = "https://api.coingecko.com/api/v3";

export const CURRENCIES = ["usd", "eur", "php"] as const;
export type Currency = (typeof CURRENCIES)[number];

export type Market = {
  id: string;
  symbol: string;
  name: string;
  image: string;
  current_price: number;
  market_cap: number;
  market_cap_rank: number;
  fully_diluted_valuation: number | null;
  total_volume: number;
  high_24h: number | null;
  low_24h: number | null;
  circulating_supply: number;
  total_supply: number | null;
  max_supply: number | null;
  ath: number;
  ath_change_percentage: number;
  ath_date: string;
  atl: number;
  atl_change_percentage: number;
  atl_date: string;
  last_updated: string;
  sparkline_in_7d: { price: number[] };
  price_change_percentage_1h_in_currency: number | null;
  price_change_percentage_24h_in_currency: number | null;
  price_change_percentage_7d_in_currency: number | null;
  price_change_percentage_30d_in_currency: number | null;
  price_change_percentage_1y_in_currency: number | null;
};

export type Global = {
  active_cryptocurrencies: number;
  markets: number;
  total_market_cap: Record<string, number>;
  total_volume: Record<string, number>;
  market_cap_percentage: Record<string, number>;
  market_cap_change_percentage_24h_usd: number;
  updated_at: number;
};

/** [timestamp ms, value] pairs. */
export type Chart = {
  prices: [number, number][];
  market_caps: [number, number][];
  total_volumes: [number, number][];
};

export class RateLimitError extends Error {
  constructor() {
    super("CoinGecko is not answering, most likely the public rate limit. Wait a minute and retry.");
    this.name = "RateLimitError";
  }
}

async function get<T>(path: string, ttlMs: number): Promise<T> {
  const key = `cg:${path}`;
  const hit = sessionStorage.getItem(key);
  if (hit) {
    const { at, data } = JSON.parse(hit) as { at: number; data: T };
    if (Date.now() - at < ttlMs) return data;
  }
  // Verified 2026-10-17: CoinGecko's 429 carries no CORS headers, so the browser surfaces it as
  // a network TypeError, never as a readable 429. Both paths mean the same thing to the user.
  const res = await fetch(`${BASE}${path}`).catch(() => {
    throw new RateLimitError();
  });
  if (res.status === 429) throw new RateLimitError();
  if (!res.ok) throw new Error(`CoinGecko ${res.status} on ${path}`);
  const data = (await res.json()) as T;
  try {
    sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), data }));
  } catch {
    // Quota exceeded (sparklines for 250 coins are ~400 kB): serve uncached, nothing lost.
  }
  return data;
}

/** Top 250 by market cap, with 7d sparklines and 1h/24h/7d/30d/1y changes. One call. */
export const fetchMarkets = (vs: Currency) =>
  get<Market[]>(
    `/coins/markets?vs_currency=${vs}&order=market_cap_desc&per_page=250&page=1&sparkline=true&price_change_percentage=1h,24h,7d,30d,1y`,
    60_000,
  );

export const fetchGlobal = () =>
  get<{ data: Global }>("/global", 60_000).then((r) => r.data);

/** `days` 1..365 or "max". Past 90 days CoinGecko returns daily points automatically. */
export const fetchChart = (id: string, vs: Currency, days: number | "max") =>
  get<Chart>(`/coins/${id}/market_chart?vs_currency=${vs}&days=${days}`, 5 * 60_000);
