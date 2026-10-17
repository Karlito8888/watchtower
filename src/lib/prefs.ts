// User preferences, persisted in localStorage. Every setter dispatches a `prefs:change`
// event on `document` so any script on the page can re-render without coupling.

import { CURRENCIES, type Currency } from "./coingecko";

export type Theme = "dark" | "light";
export type PrefsChange = { key: "currency" | "favourites" | "theme" };

const emit = (key: PrefsChange["key"]) =>
  document.dispatchEvent(new CustomEvent<PrefsChange>("prefs:change", { detail: { key } }));

export function getCurrency(): Currency {
  const v = localStorage.getItem("currency");
  return (CURRENCIES as readonly string[]).includes(v ?? "") ? (v as Currency) : "usd";
}
export function setCurrency(v: Currency) {
  localStorage.setItem("currency", v);
  emit("currency");
}

export function getFavourites(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem("favourites") ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}
export function toggleFavourite(id: string): boolean {
  const favs = getFavourites();
  const on = !favs.has(id);
  on ? favs.add(id) : favs.delete(id);
  localStorage.setItem("favourites", JSON.stringify([...favs]));
  emit("favourites");
  return on;
}

/** Stored theme, or the OS preference when the user never chose. */
export function getTheme(): Theme {
  const v = localStorage.getItem("theme");
  if (v === "dark" || v === "light") return v;
  return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}
export function setTheme(v: Theme) {
  localStorage.setItem("theme", v);
  document.documentElement.dataset.theme = v;
  emit("theme");
}
