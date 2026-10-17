import {
  AreaSeries,
  ColorType,
  createChart,
  type AreaData,
  type ChartOptions,
  type AreaSeriesPartialOptions,
  type DeepPartial,
  type UTCTimestamp,
} from "lightweight-charts";
import { fetchChart, fetchMarkets, RateLimitError } from "../lib/coingecko";
import { compact, dateShort, money, percent } from "../lib/format";
import { getCurrency, getFavourites, toggleFavourite, type PrefsChange } from "../lib/prefs";

type Days = number | "max";
type Point = { time: UTCTimestamp; value: number };

let dispose: (() => void) | undefined;

/** Chart colours come from the CSS tokens, so a theme switch only needs to re-read them. */
function palette(): { chart: DeepPartial<ChartOptions>; series: AreaSeriesPartialOptions } {
  const css = getComputedStyle(document.documentElement);
  const c = (name: string) => css.getPropertyValue(name).trim();
  const accent = c("--accent"); // 6-digit hex in global.css
  const n = parseInt(accent.slice(1), 16);
  const rgba = (a: number) => `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  const crosshair = { color: c("--muted"), labelBackgroundColor: accent };
  return {
    chart: {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: c("--muted"),
        fontFamily: css.fontFamily,
      },
      grid: { vertLines: { color: c("--border") }, horzLines: { color: c("--border") } },
      crosshair: { vertLine: crosshair, horzLine: crosshair },
      rightPriceScale: { borderColor: c("--border") },
      timeScale: { borderColor: c("--border") },
    },
    series: { lineColor: accent, topColor: rgba(0.35), bottomColor: rgba(0) },
  };
}

function init() {
  const previous = dispose;
  dispose = undefined;
  previous?.();

  const root = document.querySelector<HTMLElement>("[data-coin]");
  if (!root) return;
  const { coin: id, name } = root.dataset as { coin: string; name: string };
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const box = q("[data-chart]");
  const chartStatus = q("[data-chart-status]");
  const statsStatus = q("[data-stats-status]");
  const stats = q("[data-stats]");
  const legendPrice = q("[data-legend-price]");
  const legendDate = q("[data-legend-date]");
  const rangeChange = q("[data-range-change]");
  const fav = q("[data-fav]");
  const ranges = q("[data-days]").parentElement!;

  let alive = true;
  let days: Days = 7;
  let vs = getCurrency();
  let points: Point[] = [];
  let chartRun = 0;
  let statsRun = 0;

  const colours = palette();
  const chart = createChart(box, { autoSize: true, ...colours.chart });
  const series = chart.addSeries(AreaSeries, {
    ...colours.series,
    lineWidth: 2,
    priceLineVisible: false,
  });

  const ac = new AbortController();
  const { signal } = ac;
  dispose = () => {
    alive = false;
    ac.abort();
    chart.remove();
  };

  const set = (key: string, text: string) => {
    q(`[data-stat="${key}"]`).textContent = text;
  };
  const tone = (el: HTMLElement, v: number | null) => {
    el.classList.toggle("up", v != null && v >= 0);
    el.classList.toggle("down", v != null && v < 0);
  };

  /** Error into a `.status` box. Rate limits explain themselves, anything else gets a retry. */
  function fail(el: HTMLElement, err: unknown, retry: () => void) {
    el.hidden = false;
    el.dataset.kind = "error";
    el.textContent = err instanceof RateLimitError ? err.message : "Could not load data.";
    if (err instanceof RateLimitError) return;
    const btn = document.createElement("button");
    btn.className = "ctrl";
    btn.type = "button";
    btn.textContent = "Retry";
    btn.style.pointerEvents = "auto";
    btn.onclick = retry;
    el.append(document.createElement("br"), btn);
  }

  async function loadStats() {
    const run = ++statsRun;
    stats.dataset.loading = "";
    statsStatus.hidden = true;
    try {
      const m = (await fetchMarkets(vs)).find((x) => x.id === id);
      if (!alive || run !== statsRun) return;
      if (!m) {
        statsStatus.hidden = false;
        statsStatus.dataset.kind = "";
        statsStatus.textContent = `${name} is no longer in the top 250, so market stats are unavailable.`;
        return;
      }
      const change = m.price_change_percentage_24h_in_currency;
      set("price", money(m.current_price, vs));
      set("change", percent(change));
      tone(q('[data-stat="change"]'), change);
      set("marketCap", compact(m.market_cap, vs));
      set("fdv", compact(m.fully_diluted_valuation, vs));
      set("volume", compact(m.total_volume, vs));
      set("high", money(m.high_24h, vs));
      set("low", money(m.low_24h, vs));
      set("circ", compact(m.circulating_supply));
      set("total", compact(m.total_supply));
      set("max", compact(m.max_supply));
      const bar = q("[data-bar]");
      bar.hidden = !m.max_supply;
      if (m.max_supply) {
        const share = Math.min(100, (m.circulating_supply / m.max_supply) * 100);
        bar.querySelector("i")!.style.width = `${share}%`;
        set("circSub", `${share.toFixed(1)}% of max supply`);
      } else {
        set("circSub", "");
      }
      set("ath", money(m.ath, vs));
      set("athSub", `${dateShort(m.ath_date)} · ${percent(m.ath_change_percentage)} from ATH`);
      set("atl", money(m.atl, vs));
      set("atlSub", dateShort(m.atl_date));
      delete stats.dataset.loading;
    } catch (err) {
      if (alive && run === statsRun) fail(statsStatus, err, loadStats);
    }
  }

  const show = (p: Point) => {
    legendPrice.textContent = money(p.value, vs);
    legendDate.textContent = new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      ...(days !== "max" && days <= 90 ? { timeStyle: "short" } : {}),
    } as Intl.DateTimeFormatOptions).format(p.time * 1000);
  };

  async function loadChart() {
    const run = ++chartRun;
    chartStatus.hidden = false;
    chartStatus.dataset.kind = "";
    chartStatus.textContent = "Loading chart…";
    try {
      const { prices } = await fetchChart(id, vs, days);
      if (!alive || run !== chartRun) return;
      points = prices
        .map(([t, value]) => ({ time: Math.floor(t / 1000) as UTCTimestamp, value }))
        .filter((p, i, a) => i === 0 || p.time > a[i - 1].time); // setData needs strictly ascending times
      if (!points.length) throw new Error("Empty chart");
      chart.applyOptions({
        localization: { priceFormatter: (v: number) => money(v, vs) },
        timeScale: { timeVisible: days !== "max" && days <= 90 },
      });
      series.setData(points);
      chart.timeScale().fitContent();
      const first = points[0];
      const last = points.at(-1)!;
      const change = ((last.value - first.value) / first.value) * 100;
      rangeChange.textContent = `${percent(change)} ${ranges.querySelector(".active")!.textContent!.trim()}`;
      tone(rangeChange, change);
      show(last);
      box.ariaLabel = `${name} price chart, ${money(first.value, vs)} to ${money(last.value, vs)}`;
      chartStatus.hidden = true;
    } catch (err) {
      if (alive && run === chartRun) fail(chartStatus, err, loadChart);
    }
  }

  chart.subscribeCrosshairMove((p) => {
    const d = p.time ? (p.seriesData.get(series) as AreaData | undefined) : undefined;
    const point = d ? { time: d.time as UTCTimestamp, value: d.value } : points.at(-1);
    if (point) show(point);
  });

  ranges.addEventListener(
    "click",
    (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-days]");
      if (!btn) return;
      for (const b of ranges.querySelectorAll<HTMLButtonElement>("[data-days]")) {
        b.classList.toggle("active", b === btn);
        b.ariaPressed = String(b === btn);
      }
      days = btn.dataset.days === "max" ? "max" : Number(btn.dataset.days);
      loadChart();
    },
    { signal },
  );

  fav.addEventListener("click", () => toggleFavourite(id), { signal });
  fav.ariaPressed = String(getFavourites().has(id));

  document.addEventListener(
    "prefs:change",
    (e) => {
      const { key } = (e as CustomEvent<PrefsChange>).detail;
      if (key === "favourites") fav.ariaPressed = String(getFavourites().has(id));
      if (key === "theme") {
        const next = palette();
        chart.applyOptions(next.chart);
        series.applyOptions(next.series);
      }
      if (key === "currency") {
        vs = getCurrency();
        loadStats();
        loadChart();
      }
    },
    { signal },
  );

  loadStats();
  loadChart();
}

document.addEventListener("astro:page-load", init);
document.addEventListener("astro:before-swap", () => {
  const d = dispose;
  dispose = undefined;
  d?.();
});
