/**
 * Page glue for the constellation: starts the scene when the browser can run it and feeds it
 * `market:data`, `market:visible` and `market:focus`. The first two can fire before the scene
 * is ready, so their latest payloads are kept.
 */
import type { Market } from "../lib/coingecko";
import { startWhenIdle } from "./webgl-gate";

type Live = {
  setData(m: readonly Market[]): void;
  setVisible(ids: readonly string[]): void;
  setFocus(id: string | null): void;
  dispose(): void;
};

let latest: Market[] | null = null;
let visible: string[] | null = null;
let live: Live | null = null;
let teardown: (() => void) | undefined;

document.addEventListener("market:data", (e) => {
  latest = (e as CustomEvent<Market[]>).detail;
  live?.setData(latest);
});
document.addEventListener("market:visible", (e) => {
  visible = (e as CustomEvent<string[]>).detail;
  live?.setVisible(visible);
});
document.addEventListener("market:focus", (e) => live?.setFocus((e as CustomEvent<string | null>).detail));

function init() {
  teardown?.();
  const root = document.querySelector<HTMLElement>("[data-constellation]");
  if (!root) return;
  const canvas = root.querySelector("canvas")!;
  const toggle = root.querySelector<HTMLButtonElement>("[data-scene-toggle]")!;

  let gone = false;
  teardown = () => {
    gone = true;
    live?.dispose();
    live = null;
    teardown = undefined;
  };

  startWhenIdle(canvas, () => import("./constellation"), toggle).then((scene) => {
    if (!scene) return;
    if (gone) return scene.dispose(); // the page was swapped away while the scene loaded
    live = scene;
    if (latest) scene.setData(latest);
    if (visible) scene.setVisible(visible);
  });
}

document.addEventListener("astro:page-load", init);
document.addEventListener("astro:before-swap", () => teardown?.());
