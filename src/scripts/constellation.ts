/**
 * Market constellation: one point per coin in a golden-angle spiral. Layout depends only on
 * the index (market cap order), so a refresh never moves a point; size and colour ease
 * towards their new targets inside the render loop. Nothing is allocated per frame.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  NormalBlending,
  PerspectiveCamera,
  Points,
  Scene,
  ShaderMaterial,
  WebGLRenderer,
} from "three";
import type { Market } from "../lib/coingecko";

const N = 250;
const R = 10; // disc radius, world units
const FOV = 35;
const ELEV = (32 * Math.PI) / 180; // camera looks down at the disc
const MAX_TILT = (6 * Math.PI) / 180; // pointer parallax limit
const TAU = Math.PI * 2;
const GOLDEN = 2.399963229728653;
const SIZE_MIN = 5; // css px, smallest coin
const SIZE_MAX = 48; // css px, the biggest coin (BTC)
const TURN_SECONDS = 240;
const SETTLE = 4; // easing rate per second: ~98 % of the way after one second

const VERT = /* glsl */ `
  attribute float aSize;
  attribute vec3 aColor;
  uniform float uPx;
  uniform float uDist;
  varying vec3 vColor;
  varying float vShade;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aSize * uPx * (uDist / -mv.z);
    float far = clamp((-mv.z - uDist) / 20.0 + 0.5, 0.0, 1.0);
    vShade = 1.0 - 0.45 * far;
    vColor = aColor;
  }
`;

const FRAG = /* glsl */ `
  uniform float uHot;
  varying vec3 vColor;
  varying float vShade;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    float halo = pow(1.0 - d, 2.0) * 0.7;
    float core = 1.0 - smoothstep(0.3, 0.5, d);
    float a = clamp(halo + core * 0.9, 0.0, 1.0) * vShade;
    vec3 rgb = vColor + uHot * 0.3 * (1.0 - smoothstep(0.0, 0.3, d));
    gl_FragColor = vec4(rgb, a);
    #include <colorspace_fragment>
  }
`;

const hash = (k: number) => {
  const s = Math.sin(k * 12.9898) * 43758.5453;
  return s - Math.floor(s);
};

export function init(canvas: HTMLCanvasElement) {
  const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: false, powerPreference: "low-power" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setClearColor(0x000000, 0);

  const scene = new Scene();
  const group = new Group();
  scene.add(group);
  const camera = new PerspectiveCamera(FOV, 1, 1, 200);

  // Static layout, rank 1 (BTC) at the centre.
  const pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const r = R * Math.sqrt(i / (N - 1));
    const a = i * GOLDEN;
    pos[i * 3] = r * Math.cos(a);
    pos[i * 3 + 1] = (hash(i + 1) - 0.5) * 1.4 * (1 - 0.5 * (r / R));
    pos[i * 3 + 2] = r * Math.sin(a);
  }
  const sizeCur = new Float32Array(N);
  const sizeTgt = new Float32Array(N);
  const colCur = new Float32Array(N * 3);
  const colTgt = new Float32Array(N * 3);
  const changes = new Float32Array(N);

  const geometry = new BufferGeometry();
  const sizeAttr = new BufferAttribute(sizeCur, 1);
  const colAttr = new BufferAttribute(colCur, 3);
  geometry.setAttribute("position", new BufferAttribute(pos, 3));
  geometry.setAttribute("aSize", sizeAttr);
  geometry.setAttribute("aColor", colAttr);

  const material = new ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: { uPx: { value: 1 }, uDist: { value: 30 }, uHot: { value: 1 } },
    transparent: true,
    depthWrite: false,
  });
  const points = new Points(geometry, material);
  points.frustumCulled = false; // the bounding sphere is never worth computing here
  group.add(points);

  // Palette from the design tokens; additive glow on dark, plain alpha on light.
  const up = new Color();
  const down = new Color();
  const neutral = new Color();
  const tmp = new Color();
  const readTokens = () => {
    const cs = getComputedStyle(document.documentElement);
    up.setStyle(cs.getPropertyValue("--up").trim());
    down.setStyle(cs.getPropertyValue("--down").trim());
    neutral.setStyle(cs.getPropertyValue("--accent").trim()).lerp(tmp.setStyle(cs.getPropertyValue("--muted").trim()), 0.5);
    const dark = document.documentElement.dataset.theme !== "light";
    material.blending = dark ? AdditiveBlending : NormalBlending;
    material.uniforms.uHot.value = dark ? 1 : 0;
  };
  readTokens();

  const writeColours = () => {
    for (let i = 0; i < N; i++) {
      const c = Math.max(-1, Math.min(1, changes[i] / 10));
      tmp.copy(neutral).lerp(c < 0 ? down : up, Math.pow(Math.abs(c), 0.6));
      colTgt[i * 3] = tmp.r;
      colTgt[i * 3 + 1] = tmp.g;
      colTgt[i * 3 + 2] = tmp.b;
    }
  };
  writeColours();
  colCur.set(colTgt);

  // Layout state
  let w = 1;
  let h = 1;
  let dist = 30;
  let stretch = 1;
  let vw = innerWidth;
  let vh = innerHeight;
  let px = 0;
  let py = 0;
  let pxCur = 0;
  let pyCur = 0;
  let t = 0;
  let easing = false;
  let raf = 0;
  let last = 0;
  let disposed = false;

  const resize = (cw: number, ch: number) => {
    w = Math.max(1, cw);
    h = Math.max(1, ch);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const tanH = Math.tan((FOV * Math.PI) / 360);
    dist = (R * (Math.sin(ELEV) + 0.35)) / tanH; // whole disc fits the height
    stretch = Math.min(3, (dist * tanH * camera.aspect * 0.8) / R); // and it fills the width
    material.uniforms.uDist.value = dist;
    material.uniforms.uPx.value = renderer.getPixelRatio() * Math.max(0.7, Math.min(1.2, h / 260));
  };

  const step = (dt: number) => {
    t += dt;
    points.rotation.y = (t * TAU) / TURN_SECONDS;
    const b = 1 + 0.02 * Math.sin((t * TAU) / 7);
    group.scale.set(stretch * b, b, b);

    const k = 1 - Math.exp(-dt * 3);
    pxCur += (px - pxCur) * k;
    pyCur += (py - pyCur) * k;
    const el = ELEV + pyCur * MAX_TILT;
    const az = pxCur * MAX_TILT;
    camera.position.set(dist * Math.cos(el) * Math.sin(az), dist * Math.sin(el), dist * Math.cos(el) * Math.cos(az));
    camera.lookAt(0, 0, 0);

    if (easing) {
      const e = 1 - Math.exp(-dt * SETTLE);
      let moving = false;
      for (let i = 0; i < N; i++) {
        const d = sizeTgt[i] - sizeCur[i];
        sizeCur[i] += d * e;
        if (Math.abs(d) > 0.02) moving = true;
      }
      for (let i = 0; i < N * 3; i++) {
        const d = colTgt[i] - colCur[i];
        colCur[i] += d * e;
        if (Math.abs(d) > 0.002) moving = true;
      }
      if (!moving) {
        sizeCur.set(sizeTgt);
        colCur.set(colTgt);
        easing = false;
      }
      sizeAttr.needsUpdate = true;
      colAttr.needsUpdate = true;
    }
  };

  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    const dt = last ? Math.min((now - last) / 1000, 0.1) : 0;
    last = now;
    step(dt);
    renderer.render(scene, camera);
  };

  // While paused the loop is off: changes snap and draw one still frame.
  const redraw = () => {
    if (raf || disposed) return;
    sizeCur.set(sizeTgt);
    colCur.set(colTgt);
    easing = false;
    sizeAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    step(0);
    renderer.render(scene, camera);
  };

  const onPointer = (e: PointerEvent) => {
    px = (e.clientX / vw) * 2 - 1;
    py = (e.clientY / vh) * 2 - 1;
  };
  const onWindowResize = () => {
    vw = innerWidth;
    vh = innerHeight;
  };
  const onPrefs = (e: Event) => {
    if ((e as CustomEvent<{ key: string }>).detail.key !== "theme") return;
    readTokens();
    writeColours();
    easing = true;
    redraw();
  };

  const parent = canvas.parentElement ?? canvas;
  const ro = new ResizeObserver(([entry]) => {
    resize(entry.contentRect.width, entry.contentRect.height);
    redraw();
  });
  ro.observe(parent);
  addEventListener("pointermove", onPointer, { passive: true });
  addEventListener("resize", onWindowResize, { passive: true });
  document.addEventListener("prefs:change", onPrefs);
  const rect = parent.getBoundingClientRect(); // once, before the observer's first callback
  resize(rect.width, rect.height);

  return {
    start() {
      if (raf || disposed) return;
      last = 0;
      raf = requestAnimationFrame(frame);
    },
    stop() {
      cancelAnimationFrame(raf);
      raf = 0;
    },
    setData(markets: readonly Market[]) {
      if (disposed) return;
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < N && i < markets.length; i++) {
        const cap = markets[i].market_cap;
        if (cap > 0) {
          const l = Math.log10(cap);
          if (l < lo) lo = l;
          if (l > hi) hi = l;
        }
      }
      const span = Math.max(hi - lo, 1e-6);
      for (let i = 0; i < N; i++) {
        const m = markets[i];
        if (!m || !(m.market_cap > 0)) {
          sizeTgt[i] = 0;
          changes[i] = 0;
          continue;
        }
        const n = (Math.log10(m.market_cap) - lo) / span;
        sizeTgt[i] = SIZE_MIN + (SIZE_MAX - SIZE_MIN) * Math.pow(n, 1.6);
        changes[i] = m.price_change_percentage_24h_in_currency ?? 0;
      }
      writeColours();
      easing = true;
      redraw();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      raf = 0;
      ro.disconnect();
      removeEventListener("pointermove", onPointer);
      removeEventListener("resize", onWindowResize);
      document.removeEventListener("prefs:change", onPrefs);
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
