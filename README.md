# Watchtower

Top 250 cryptocurrencies by market cap, with prices, 7 day sparklines, multi-period changes and
a price chart per coin. Live at https://watchtower.charmaweb.com.

Data: CoinGecko public API, called from the browser without an API key. Each visitor spends
their own IP quota; responses are cached in `sessionStorage` for a minute.

```sh
bun install
bun run dev      # http://localhost:4350
bun run check    # astro check + build
```

Deploys to a Cloudflare Worker (static assets) on every push to `main`, plus a daily rebuild
so the pre-rendered `/coin/<id>` pages follow the top 250.
