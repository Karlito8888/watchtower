# AGENTS.md — watchtower

Crypto market dashboard: top 250 coins, sparklines, per-coin price chart. Portfolio piece,
live at `https://watchtower.charmaweb.com`.

## What is NOT here

| What | Where |
|---|---|
| General working rules, docs ladder, git, explicit agreement | `~/.omp/agent/RULES.md` |
| Workstation, code graphs, workflows | `~/.omp/agent/AGENTS.md` |
| Durable project facts, deploy identities, debts | `~/.omp/agent/bank/watchtower.md` |

## Stack

Astro 7 static output, Bun, TypeScript, no UI framework. `lightweight-charts` (TradingView)
for the coin chart, `motion` for the row fade-in. Self-hosted Inter via the Astro fonts API.
Astro `<ClientRouter />` drives view transitions, so every page script initialises on
`astro:page-load`, is idempotent, and disposes on `astro:before-swap`.

## Data

CoinGecko public API, called from the browser, no API key: each visitor spends their own IP
quota (about 10 to 30 calls per minute). `src/lib/coingecko.ts` is the only place that knows
URLs, caches every response in `sessionStorage` (60 s markets and global, 5 min charts) and
throws `RateLimitError`. A CoinGecko 429 carries no CORS headers, so the browser reports it as
a network `TypeError`: the client treats any fetch rejection as a rate limit on purpose.

`/coin/[id]` pages are pre-rendered at build time for the top 250 of that moment
(`getStaticPaths` does one server-side call). The GitHub Actions workflow rebuilds daily so the
set follows the market. A coin outside the top 250 lands on `src/pages/404.astro`.

## Layout

- `src/layouts/Base.astro`: head, sticky header with the currency `<select>` and the theme
  toggle, footer. The theme is applied inline before first paint.
- `src/lib/prefs.ts`: currency, favourites and theme in `localStorage`; every setter dispatches
  `prefs:change` on `document`, pages listen and re-render.
- `src/pages/index.astro` + `src/scripts/market.ts`: global banner, toolbar, table. View state
  (query, tab, sort, top N) lives in module scope, never in storage. Every cell carries a
  `c-<column>` class; four CSS tiers drop columns by usefulness (1400, 1200, 1024, 768 px), and
  under 768 px each row is a two-line grid card with no `<thead>`, the toolbar `<select>` sorts.
- `src/pages/coin/[id].astro` + `src/scripts/coin.ts`: static shell from build-time props,
  chart and stats filled client-side.
- `src/styles/global.css`: tokens (`--bg --surface --border --fg --muted --accent --up --down`)
  with a light variant under `html[data-theme="light"]`; components use only tokens.

## Commands

```sh
bun run dev      # http://localhost:4350, Astro 7 daemonises: `bunx astro dev stop` to end it
bun run check    # astro check + astro build, what CI runs
```

Deploy: push to `main`. `wrangler.jsonc` publishes `dist/` as a Cloudflare Worker with static
assets on the custom domain. Repo secret `CLOUDFLARE_API_TOKEN`, repo variable
`CLOUDFLARE_ACCOUNT_ID`, same as `abaddon`.
