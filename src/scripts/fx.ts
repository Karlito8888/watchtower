import { animate } from "motion";

export const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Same encoding Astro applies to `transition:name`, so a name built here pairs with one set in a template. */
export const vtName = (prefix: string, id: string) =>
  `${prefix}-${id.replace(/[^a-zA-Z0-9-]/g, (c) => (c === "_" ? "__" : `_${c.charCodeAt(0).toString(16).padStart(2, "0")}`))}`;

type Tween = { v: number; run?: { stop(): void } };
const tweens = new WeakMap<Element, Tween>();

/**
 * Glide an element's text from the value it last showed (0 on first paint) to `to`, formatting every frame with `fmt`.
 * `null`/`undefined` shows `fallback`. Reduced motion sets the final text at once.
 */
export function countTo(el: HTMLElement, to: number | null | undefined, fmt: (n: number) => string, fallback = "–") {
  let t = tweens.get(el);
  if (!t) tweens.set(el, (t = { v: 0 }));
  t.run?.stop();
  t.run = undefined;
  if (to == null) {
    t.v = 0;
    el.textContent = fallback;
    return;
  }
  const tween = t;
  if (reduced() || to === tween.v) {
    tween.v = to;
    el.textContent = fmt(to);
    return;
  }
  el.textContent = fmt(tween.v);
  tween.run = animate(tween.v, to, {
    duration: 0.8,
    ease: [0.33, 1, 0.68, 1],
    onUpdate: (n) => {
      tween.v = n;
      el.textContent = fmt(n);
    },
    onComplete: () => {
      tween.v = to;
      el.textContent = fmt(to);
    },
  });
}

/** Quick 1 → 1.3 → 1 scale pop, used when a favourite star turns on. */
export function pop(el: Element | null) {
  if (el && !reduced()) animate(el, { transform: ["scale(1)", "scale(1.3)", "scale(1)"] }, { duration: 0.25, ease: "easeOut" });
}
