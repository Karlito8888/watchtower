/**
 * Starts a three.js scene only when it can run and should run: no reduced-motion
 * preference, WebGL 2 available, after `load` and an idle slot. The canvas is fixed and
 * always on screen, so the loop only stops on the pause button (WCAG 2.2.2) or a
 * reduced-motion switch; hidden tabs stop it through requestAnimationFrame. It swallows
 * every failure so the static fallback stays in place and resolves to `null` then; on
 * success it resolves to the scene, so the page can push data into it. Button labels
 * come from `data-pause` / `data-play`.
 */
export interface Scene {
  start(): void;
  stop(): void;
}

export async function startWhenIdle<T extends Scene>(
  canvas: HTMLCanvasElement,
  load: () => Promise<{ init(canvas: HTMLCanvasElement): T | Promise<T> }>,
  toggle: HTMLButtonElement,
): Promise<T | null> {
  const mq = matchMedia("(prefers-reduced-motion: reduce)");
  if (mq.matches) return null;
  try {
    if (!(window.WebGL2RenderingContext && document.createElement("canvas").getContext("webgl2"))) return null;
  } catch {
    return null;
  }

  const idle = Promise.withResolvers<void>();
  const schedule = () =>
    "requestIdleCallback" in window
      ? requestIdleCallback(() => idle.resolve(), { timeout: 2000 })
      : setTimeout(idle.resolve, 200);
  if (document.readyState === "complete") schedule();
  else addEventListener("load", schedule, { once: true });
  await idle.promise;

  try {
    const scene = await (await load()).init(canvas);
    let paused = false;
    const sync = () => (paused ? scene.stop() : scene.start());

    sync();
    canvas.classList.add("is-live");
    toggle.hidden = false;

    toggle.addEventListener("click", () => {
      paused = !paused;
      toggle.setAttribute("aria-pressed", String(paused));
      toggle.textContent = paused ? toggle.dataset.play! : toggle.dataset.pause!;
      sync();
    });

    mq.addEventListener("change", (e) => {
      if (!e.matches) return;
      paused = true;
      toggle.setAttribute("aria-pressed", "true");
      toggle.textContent = toggle.dataset.play!;
      sync();
    });
    return scene;
  } catch (err) {
    console.warn("Animation disabled:", err);
    return null;
  }
}
