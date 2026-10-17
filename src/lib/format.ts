import type { Currency } from "./coingecko";

const LOCALE = "en-US";

/** Prices: 2 decimals above 1, up to 6 significant digits below (cheap alt-coins). */
export function money(value: number | null | undefined, vs: Currency): string {
  if (value == null) return "–";
  const abs = Math.abs(value);
  return new Intl.NumberFormat(LOCALE, {
    style: "currency",
    currency: vs.toUpperCase(),
    ...(abs >= 1
      ? { maximumFractionDigits: 2 }
      : { minimumFractionDigits: 2, maximumSignificantDigits: 4 }),
  }).format(value);
}

/** Market caps and volumes: $1.64T, €25.1B. */
export function compact(value: number | null | undefined, vs?: Currency): string {
  if (value == null) return "–";
  return new Intl.NumberFormat(LOCALE, {
    notation: "compact",
    maximumFractionDigits: 2,
    ...(vs ? { style: "currency", currency: vs.toUpperCase() } : {}),
  }).format(value);
}

/** +1.23% / -0.67%, sign always shown. */
export function percent(value: number | null | undefined): string {
  if (value == null) return "–";
  return new Intl.NumberFormat(LOCALE, {
    style: "percent",
    signDisplay: "exceptZero",
    maximumFractionDigits: 2,
  }).format(value / 100);
}

export const dateShort = (iso: string | number) =>
  new Intl.DateTimeFormat(LOCALE, { dateStyle: "medium" }).format(new Date(iso));
