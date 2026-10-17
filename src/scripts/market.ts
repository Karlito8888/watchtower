import { animate, stagger } from "motion";
import { navigate } from "astro:transitions/client";
import { fetchGlobal, fetchMarkets, RateLimitError, type Currency, type Global, type Market } from "../lib/coingecko";
import { getCurrency, getFavourites, toggleFavourite, type PrefsChange } from "../lib/prefs";
import { compact, money, percent } from "../lib/format";
import { countTo, pop, reduced, vtName } from "./fx";

const STABLES: Record<string, true> = Object.fromEntries(
  "usdt usdc dai busd tusd usdd fdusd usde pyusd usds frax lusd gusd usdp eurc eurt ust".split(" ").map((s) => [s, true]),
);
const isStable = (m: Market) => m.symbol.toLowerCase() in STABLES || /usd/i.test(m.name);

const SORTS: Record<string, (m: Market) => number | string | null> = {
  rank: (m) => m.market_cap_rank,
  name: (m) => m.name,
  price: (m) => m.current_price,
  h1: (m) => m.price_change_percentage_1h_in_currency,
  h24: (m) => m.price_change_percentage_24h_in_currency,
  d7: (m) => m.price_change_percentage_7d_in_currency,
  d30: (m) => m.price_change_percentage_30d_in_currency,
  y1: (m) => m.price_change_percentage_1y_in_currency,
  mcap: (m) => m.market_cap,
  vol: (m) => m.total_volume,
};

// View state lives in module scope: it survives ClientRouter navigations, never touches storage.
const view = { q: "", tab: "all" as "all" | "fav", hide: true, top: 250, sort: "rank", dir: 1 as 1 | -1 };

type Ctx = {
  root: HTMLElement;
  rows: Map<string, HTMLTableRowElement>;
  data: Market[];
  seq: number;
  rendered: boolean;
  flips: { cancel(): void }[];
};
let ctx: Ctx | null = null;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const q = <T extends HTMLElement>(sel: string) => ctx!.root.querySelector<T>(sel)!;
const tone = (v: number | null | undefined) => (v == null || v === 0 ? "" : v > 0 ? "up" : "down");
const starLabel = (name: string, on: boolean) => `${on ? "Remove" : "Add"} ${name} ${on ? "from" : "to"} favourites`;

function sparkline(prices: number[] | undefined) {
  if (!prices || prices.length < 2) return "";
  const step = Math.ceil(prices.length / 56);
  const pts = prices.filter((_, i) => i % step === 0 || i === prices.length - 1);
  const lo = Math.min(...pts);
  const span = Math.max(...pts) - lo || 1;
  const line = pts
    .map((p, i) => `${((i / (pts.length - 1)) * 120).toFixed(1)},${(33 - ((p - lo) / span) * 30).toFixed(1)}`)
    .join(" ");
  const dir = prices[prices.length - 1] >= prices[0] ? "up" : "down";
  return `<svg class="${dir}" width="120" height="36" viewBox="0 0 120 36" aria-hidden="true"><polygon points="${line} 120,36 0,36" fill="url(#spark-${dir})"/><polyline points="${line}" pathLength="1" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

function rowHtml(m: Market, vs: Currency, favs: Set<string>) {
  const on = favs.has(m.id);
  const name = esc(m.name);
  const pct = (k: string, v: number | null) => `<td class="num c-${k} ${tone(v)}">${percent(v)}</td>`;
  return `<tr data-id="${esc(m.id)}" data-name="${name}"><td class="num muted c-rank">${m.market_cap_rank ?? "–"}</td><td class="c-star"><button type="button" class="star" data-star aria-pressed="${on}" aria-label="${starLabel(name, on)}"><svg width="18" height="18" viewBox="0 0 24 24" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z"/></svg></button></td><td class="coin c-coin"><a href="/coin/${esc(m.id)}"><img src="${esc(m.image)}" width="24" height="24" alt="" loading="lazy" decoding="async" style="view-transition-name:${vtName("coin", m.id)}"><span class="nm" style="view-transition-name:${vtName("coin-name", m.id)}">${name}</span><span class="sym">${esc(m.symbol.toUpperCase())}</span></a></td><td class="num c-price">${money(m.current_price, vs)}</td>${pct("h1", m.price_change_percentage_1h_in_currency)}${pct("h24", m.price_change_percentage_24h_in_currency)}${pct("d7", m.price_change_percentage_7d_in_currency)}${pct("d30", m.price_change_percentage_30d_in_currency)}${pct("y1", m.price_change_percentage_1y_in_currency)}<td class="num c-mcap">${compact(m.market_cap, vs)}</td><td class="num c-vol">${compact(m.total_volume, vs)}</td><td class="spark c-spark">${sparkline(m.sparkline_in_7d?.price)}</td></tr>`;
}

function stat(name: string, v: number | null | undefined, fmt: (n: number) => string, cls = "", fallback = "–") {
  const el = q(`[data-stat="${name}"]`);
  el.className = cls; // drops the skeleton class on the first value
  countTo(el, v, fmt, fallback);
}

function renderBanner(g: Global | null, vs: Currency) {
  const chg = g?.market_cap_change_percentage_24h_usd;
  const pct = (n: number) => `${n.toFixed(1)}%`;
  stat("cap", g?.total_market_cap[vs], (n) => compact(n, vs));
  stat("capchg", chg, (n) => `${percent(n)} 24h`, tone(chg), "");
  stat("vol", g?.total_volume[vs], (n) => compact(n, vs));
  stat("btc", g?.market_cap_percentage.btc, pct);
  stat("eth", g?.market_cap_percentage.eth, pct);
  stat("coins", g?.active_cryptocurrencies, (n) => new Intl.NumberFormat("en-US").format(Math.round(n)));
}

/** Tops of the rows on screen (max 40) by id: the "First" of FLIP. Reads only, one layout flush. */
function visibleTops() {
  const tops = new Map<string, number>();
  for (const tr of q<HTMLTableSectionElement>("[data-tbody]").rows) {
    const { top, bottom } = tr.getBoundingClientRect();
    if (top >= innerHeight || tops.size >= 40) break;
    if (bottom > 0 && tr.dataset.id) tops.set(tr.dataset.id, top);
  }
  return tops;
}

/** Rows still on screen glide from where they were, rows that just entered fade in. All reads happen before any animation starts. */
function flip(c: Ctx, before: Map<string, number>) {
  const moved: [HTMLTableRowElement, number][] = [];
  const fresh: HTMLTableRowElement[] = [];
  for (const tr of q<HTMLTableSectionElement>("[data-tbody]").rows) {
    const { top, bottom } = tr.getBoundingClientRect();
    if (top >= innerHeight || moved.length + fresh.length >= 40) break;
    if (bottom <= 0 || !tr.dataset.id) continue;
    const old = before.get(tr.dataset.id);
    if (old == null) fresh.push(tr);
    else if (Math.abs(old - top) > 1) moved.push([tr, old - top]);
  }
  for (const [tr, d] of moved) c.flips.push(animate(tr, { y: [d, 0] }, { duration: 0.35, ease: [0.22, 1, 0.36, 1] }));
  if (fresh.length) c.flips.push(animate(fresh, { opacity: [0, 1] }, { duration: 0.25 }));
}

/** Polylines draw themselves (pathLength is 1, so dash units are fractions of the line) while the fill fades in. */
function drawSparklines(rows: HTMLTableRowElement[]) {
  const lines = rows.flatMap((tr) => tr.querySelector("polyline") ?? []);
  const fills = rows.flatMap((tr) => tr.querySelector("polygon") ?? []);
  for (const l of lines) {
    l.style.strokeDasharray = "1 2";
    l.style.strokeDashoffset = "1";
  }
  const opts = { duration: 0.6, delay: stagger(0.02), ease: "easeOut" } as const;
  Promise.all([animate(fills, { opacity: [0, 1] }, opts), animate(lines, { strokeDashoffset: [1, 0] }, opts)]).then(() => {
    for (const el of [...lines, ...fills]) el.removeAttribute("style");
  });
}

const snapshot = () => (ctx!.rendered && !reduced() ? visibleTops() : null);

function apply(before = snapshot()) {
  const c = ctx!;
  const favs = getFavourites();
  const text = view.q.trim().toLowerCase();
  // Stablecoin hiding and Top N only shape the plain browse view: a search or the Favourites tab must find everything.
  const browsing = view.tab === "all" && !text;
  let list = c.data.filter(
    (m) =>
      (view.tab === "all" || favs.has(m.id)) &&
      (!text || m.name.toLowerCase().includes(text) || m.symbol.toLowerCase().includes(text)) &&
      !(browsing && view.hide && isStable(m)),
  );
  if (browsing) list = list.slice(0, view.top);
  const get = SORTS[view.sort];
  list.sort((a, b) => {
    const x = get(a);
    const y = get(b);
    if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1;
    return (typeof x === "string" ? x.localeCompare(y as string) : x - (y as number)) * view.dir;
  });

  for (const a of c.flips) a.cancel(); // after the snapshot (it holds the in-flight positions), before the DOM changes
  c.flips.length = 0;
  const frag = document.createDocumentFragment();
  for (const m of list) frag.append(c.rows.get(m.id)!);
  q("[data-tbody]").replaceChildren(frag);

  q("[data-wrap]").hidden = !list.length;
  const empty = q("[data-empty]");
  empty.hidden = !!list.length;
  empty.textContent = text ? `No coin matches "${view.q.trim()}".` : "Star a coin to pin it here.";
  q("[data-count]").textContent = `${list.length} coins shown`;
  document.dispatchEvent(new CustomEvent<string[]>("market:visible", { detail: list.map((m) => m.id) }));

  c.root.querySelectorAll<HTMLElement>("th[data-sort]").forEach((th) => {
    if (th.dataset.sort === view.sort) th.setAttribute("aria-sort", view.dir === 1 ? "ascending" : "descending");
    else th.removeAttribute("aria-sort");
  });
  q<HTMLSelectElement>("[data-sort-select]").value = view.sort;
  if (before) flip(c, before);
}

function syncStars() {
  const favs = getFavourites();
  q("[data-fav-count]").textContent = String(favs.size);
  ctx!.rows.forEach((tr, id) => {
    const on = favs.has(id);
    const b = tr.querySelector<HTMLElement>("[data-star]")!;
    const was = b.getAttribute("aria-pressed") === "true";
    b.setAttribute("aria-pressed", String(on));
    b.setAttribute("aria-label", starLabel(tr.dataset.name!, on));
    if (on && !was) pop(b.querySelector("svg"));
  });
}

function syncControls() {
  const { root } = ctx!;
  q<HTMLInputElement>("[data-search]").value = view.q;
  root.querySelectorAll<HTMLElement>("[data-tab]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.tab === view.tab)));
  root.querySelectorAll<HTMLElement>("[data-top]").forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset.top! === view.top)));
  q("[data-hide]").setAttribute("aria-pressed", String(view.hide));
  q("[data-fav-count]").textContent = String(getFavourites().size);
}

async function load(silent: boolean) {
  const c = ctx!;
  const vs = getCurrency();
  const n = ++c.seq;
  const wrap = q("[data-wrap]");
  if (!silent) {
    wrap.setAttribute("aria-busy", "true");
    q("[data-error]").hidden = true;
  }
  const [m, g] = await Promise.allSettled([fetchMarkets(vs), fetchGlobal()]);
  if (ctx !== c || n !== c.seq) return; // page swapped or a newer load took over
  if (g.status === "fulfilled") renderBanner(g.value, vs);
  else if (!silent) renderBanner(null, vs);

  if (m.status === "fulfilled") {
    c.data = m.value;
    document.dispatchEvent(new CustomEvent<Market[]>("market:data", { detail: m.value }));
    const favs = getFavourites();
    const before = snapshot();
    const body = q<HTMLTableSectionElement>("[data-tbody]");
    body.innerHTML = m.value.map((x) => rowHtml(x, vs, favs)).join("");
    c.rows = new Map(Array.from(body.rows, (tr) => [tr.dataset.id!, tr]));
    apply(before);
    if (!c.rendered && !reduced()) {
      const first = Array.from(body.rows).slice(0, 30);
      animate(first, { opacity: [0, 1], y: [8, 0] }, { duration: 0.4, delay: stagger(0.02) });
      drawSparklines(first);
    }
    c.rendered = true;
  } else if (!silent) {
    c.data = [];
    c.rows.clear();
    q("[data-tbody]").replaceChildren();
    wrap.hidden = true;
    q("[data-empty]").hidden = true;
    q("[data-error-text]").textContent =
      m.reason instanceof RateLimitError ? m.reason.message : "Could not load market data. Check your connection and retry.";
    q("[data-error]").hidden = false;
  }
  wrap.removeAttribute("aria-busy");
}

function init() {
  const root = document.querySelector<HTMLElement>("[data-market]");
  if (!root) {
    ctx = null;
    return;
  }
  ctx = { root, rows: new Map(), data: [], seq: 0, rendered: false, flips: [] };
  syncControls();

  let timer: number;
  q<HTMLInputElement>("[data-search]").addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      view.q = (e.target as HTMLInputElement).value;
      if (ctx?.data.length) apply();
    }, 150);
  });
  // Phones and tablets: hidden headers cannot be clicked, the select sorts instead (always descending, rank ascending).
  q<HTMLSelectElement>("[data-sort-select]").addEventListener("change", (e) => {
    view.sort = (e.target as HTMLSelectElement).value;
    view.dir = view.sort === "rank" ? 1 : -1;
    if (ctx?.data.length) apply();
  });

  root.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const hit = (sel: string) => t.closest<HTMLElement>(sel);
    const redraw = () => {
      syncControls();
      if (ctx!.data.length) apply();
    };
    let el: HTMLElement | null;
    if ((el = hit("[data-star]"))) toggleFavourite(el.closest<HTMLElement>("tr")!.dataset.id!);
    else if ((el = hit("[data-tab]"))) ((view.tab = el.dataset.tab as typeof view.tab), redraw());
    else if ((el = hit("[data-top]"))) ((view.top = +el.dataset.top!), redraw());
    else if (hit("[data-hide]")) ((view.hide = !view.hide), redraw());
    else if (hit("[data-retry]")) load(false);
    else if ((el = hit("th[data-sort]"))) {
      const key = el.dataset.sort!;
      view.dir = key === view.sort ? (-view.dir as 1 | -1) : key === "rank" || key === "name" ? 1 : -1;
      view.sort = key;
      if (ctx!.data.length) apply();
    } else if ((el = hit("tbody tr[data-id]")) && !hit("a")) navigate(`/coin/${el.dataset.id}`);
  });

  // Table to constellation: hovered row id, or null. Scene to table: `scene:focus` highlights the row.
  const focus = (id: string | null) => document.dispatchEvent(new CustomEvent<string | null>("market:focus", { detail: id }));
  root.addEventListener("pointerover", (e) => {
    const tr = (e.target as HTMLElement).closest<HTMLElement>("tbody tr[data-id]");
    if (tr) focus(tr.dataset.id!);
  });
  root.addEventListener("pointerout", (e) => {
    const tr = (e.target as HTMLElement).closest<HTMLElement>("tbody tr[data-id]");
    if (tr && !tr.contains(e.relatedTarget as Node | null)) focus(null);
  });

  load(false);
}

document.addEventListener("astro:page-load", init);
document.addEventListener("prefs:change", (e) => {
  if (!ctx) return;
  const { key } = (e as CustomEvent<PrefsChange>).detail;
  if (key === "currency") load(false);
  else if (key === "favourites") {
    syncStars();
    if (ctx.data.length) apply();
  }
});
document.addEventListener("scene:focus", (e) => {
  if (!ctx) return;
  const id = (e as CustomEvent<string | null>).detail;
  ctx.root.querySelector("tbody tr.is-focus")?.classList.remove("is-focus");
  if (id) ctx.rows.get(id)?.classList.add("is-focus");
});
// 61s, not 60s: the API cache TTL is 60s, so a 60s tick can land just inside it and skip the refresh.
setInterval(() => {
  if (ctx && document.visibilityState === "visible") load(true);
}, 61_000);
