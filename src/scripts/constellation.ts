/**
 * Market constellation: one point per coin in a golden-angle spiral. Layout depends only on
 * the index (market cap order), so a refresh never moves a point; size and colour ease
 * towards their new targets inside the render loop. Per-point scale and alpha ease the same
 * way and carry hover, table focus, table filtering and the click dive. Pointer Events drive
 * the picking (nearest point in screen space), drag to spin and tilt, wheel and pinch to
 * zoom, double-tap to reset. Nothing is allocated per frame except the tooltip transform string.
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
  Vector3,
  WebGLRenderer,
} from "three";
import { navigate } from "astro:transitions/client";
import type { Market } from "../lib/coingecko";
import { money, percent } from "../lib/format";
import { getCurrency } from "../lib/prefs";

const N = 250;
const R = 10; // disc radius, world units
const FOV = 35;
const DEG = Math.PI / 180;
const ELEV = 32 * DEG; // camera looks down at the disc
const ELEV_MIN = 10 * DEG;
const ELEV_MAX = 60 * DEG;
const MAX_TILT = 6 * DEG; // pointer parallax limit
const TAU = Math.PI * 2;
const GOLDEN = 2.399963229728653;
const SIZE_MIN = 5; // css px, smallest coin
const SIZE_MAX = 48; // css px, the biggest coin (BTC)
const TURN_SECONDS = 240;
const SETTLE = 4; // easing rate per second: ~98 % of the way after one second
const FX_RATE = 9; // scale and alpha easing: ~97 % after 400 ms
const HOT = 1.8; // size factor of the hovered, focused or dived point
const DIM_ALPHA = 0.15; // coins the table filtered out
const DIM_SIZE = 0.6;
const DIVE_DIM = 0.2;
const HIT = 14; // css px, minimum pick radius
const TAP_PX = 6; // movement under this is a click or a tap
const SPIN_PX = 0.005; // radians of spin per dragged css px
const TILT_PX = 0.006;
const INERTIA = 3.5; // spin velocity decay per second
const ZOOM_MIN = 0.6;
const ZOOM_MAX = 1.8;
const RESET_S = 0.6;
const DIVE_S = 0.55;
const DIVE_ZOOM = 0.5;
const [NONE, PENDING, DRAG, PINCH, IGNORE] = [0, 1, 2, 3, 4]; // gesture modes

const VERT = /* glsl */ `
  attribute float aSize;
  attribute float aScale;
  attribute float aAlpha;
  attribute vec3 aColor;
  uniform float uPx;
  uniform float uDist;
  uniform float uCam;
  varying vec3 vColor;
  varying float vShade;
  varying float vHot;
  varying float vAlpha;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aSize * aScale * uPx * (uDist / -mv.z);
    float far = clamp((-mv.z - uCam) / 20.0 + 0.5, 0.0, 1.0);
    vShade = 1.0 - 0.45 * far;
    vColor = aColor;
    vHot = smoothstep(1.0, 1.8, aScale);
    vAlpha = aAlpha;
  }
`;

const FRAG = /* glsl */ `
  uniform float uHot;
  varying vec3 vColor;
  varying float vShade;
  varying float vHot;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    float halo = pow(1.0 - d, 2.0) * 0.7;
    float core = 1.0 - smoothstep(0.3, 0.5, d);
    float a = clamp(halo + core * 0.9 + vHot * 0.3, 0.0, 1.0) * vShade * vAlpha;
    vec3 rgb = vColor + uHot * (0.3 + 0.5 * vHot) * (1.0 - smoothstep(0.0, 0.3 + 0.3 * vHot, d));
    rgb *= 1.0 - (1.0 - uHot) * vHot * 0.3;
    gl_FragColor = vec4(rgb, a);
    #include <colorspace_fragment>
  }
`;

const hash = (k: number) => {
  const s = Math.sin(k * 12.9898) * 43758.5453;
  return s - Math.floor(s);
};
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

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
  const scaleCur = new Float32Array(N).fill(1);
  const scaleTgt = new Float32Array(N).fill(1);
  const alphaCur = new Float32Array(N).fill(1);
  const alphaTgt = new Float32Array(N).fill(1);
  const vis = new Uint8Array(N).fill(1); // 0 when the table filtered the coin out
  const colCur = new Float32Array(N * 3);
  const colTgt = new Float32Array(N * 3);
  const changes = new Float32Array(N);

  const geometry = new BufferGeometry();
  const sizeAttr = new BufferAttribute(sizeCur, 1);
  const scaleAttr = new BufferAttribute(scaleCur, 1);
  const alphaAttr = new BufferAttribute(alphaCur, 1);
  const colAttr = new BufferAttribute(colCur, 3);
  geometry.setAttribute("position", new BufferAttribute(pos, 3));
  geometry.setAttribute("aSize", sizeAttr);
  geometry.setAttribute("aScale", scaleAttr);
  geometry.setAttribute("aAlpha", alphaAttr);
  geometry.setAttribute("aColor", colAttr);

  const material = new ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: { uPx: { value: 1 }, uDist: { value: 30 }, uCam: { value: 30 }, uHot: { value: 1 } },
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
  let hf = 1; // height factor, same as the shader's point-size scale
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
  let fxEasing = false;
  let raf = 0;
  let kicking = 0;
  let last = 0;
  let disposed = false;

  // Camera state: spin adds to the auto-rotation, elev and zoom are user-driven, ctr is the
  // orbit target (the origin, except during a dive). A tween takes all of them to a goal.
  let spin = 0;
  let spinVel = 0;
  let elev = ELEV;
  let zoom = 1;
  let zoomTgt = 1;
  const ctr = new Vector3();
  const tween = { k: 1, dur: 1, spin0: 0, spin1: 0, elev0: 0, elev1: 0, zoom0: 0, zoom1: 0 };

  // Data and interaction state
  let data: readonly Market[] = [];
  const idIndex = new Map<string, number>();
  let visIds: readonly string[] | null = null;
  let pick = -1; // point under the mouse, or the tapped one
  let touchPick = -1;
  let focus = -1; // point whose table row is hovered
  let diving = -1;
  let navigated = false;
  let mouseIn = false;
  let mx = 0;
  let my = 0;
  let dragging = false;
  let rect = canvas.getBoundingClientRect();
  let mode = NONE;
  let gx = 0;
  let gy = 0;
  let gt = 0;
  let travel = 0;
  let accDx = 0;
  let accT = 0;
  let pinchD = 0;
  let lastEmptyTap = 0;
  const ptrs = new Map<number, { x: number; y: number }>();

  // Tooltip, markup lives in Constellation.astro
  const parent = canvas.parentElement ?? canvas;
  const tip = parent.querySelector<HTMLElement>("[data-tip]")!;
  const tipImg = tip.querySelector<HTMLImageElement>("[data-tip-img]")!;
  const tipNm = tip.querySelector<HTMLElement>("[data-tip-nm]")!;
  const tipSym = tip.querySelector<HTMLElement>("[data-tip-sym]")!;
  const tipPx = tip.querySelector<HTMLElement>("[data-tip-px]")!;
  const tipCh = tip.querySelector<HTMLElement>("[data-tip-ch]")!;
  let tipSrc = "";
  let tipW = 0;
  let tipH = 0;

  // Screen position (css px in the canvas) and view depth of point i, left in sx, sy, sz.
  const v = new Vector3();
  let sx = 0;
  let sy = 0;
  let sz = 1;
  const proj = (i: number) => {
    v.fromArray(pos, i * 3).applyMatrix4(points.matrixWorld).applyMatrix4(camera.matrixWorldInverse);
    sz = -v.z;
    v.applyMatrix4(camera.projectionMatrix);
    sx = (v.x * 0.5 + 0.5) * w;
    sy = (0.5 - v.y * 0.5) * h;
  };
  const cssSize = (i: number) => sizeCur[i] * scaleCur[i] * hf * (dist / sz);

  /** Nearest visible point to (lx, ly) within its pick radius, -1 when none. */
  const nearest = (lx: number, ly: number) => {
    if (lx < 0 || lx > w || ly < 0 || ly > h) return -1;
    let best = -1;
    let bestScore = 1;
    for (let i = 0; i < N; i++) {
      if (vis[i] === 0 || sizeCur[i] < 1) continue;
      proj(i);
      if (sz < 1) continue;
      const r = Math.max(HIT, cssSize(i) * 0.3);
      const dx = sx - lx;
      const dy = sy - ly;
      const score = (dx * dx + dy * dy) / (r * r);
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return best;
  };

  const hot = (i: number) => {
    if (i < 0) return;
    scaleTgt[i] = HOT;
    alphaTgt[i] = 1;
  };
  /** Rewrites every scale and alpha target from filter, hover, focus and dive state. */
  const retarget = () => {
    const dive = diving >= 0;
    for (let i = 0; i < N; i++) {
      const on = vis[i] === 1;
      scaleTgt[i] = on ? 1 : DIM_SIZE;
      alphaTgt[i] = dive ? DIVE_DIM : on ? 1 : DIM_ALPHA;
    }
    if (!dive) {
      hot(pick);
      hot(focus);
    }
    hot(diving);
    fxEasing = true;
  };

  const fillTip = () => {
    const m = data[pick];
    if (!m) return;
    if (tipSrc !== m.image) tipImg.src = tipSrc = m.image;
    tipNm.textContent = m.name;
    tipSym.textContent = m.symbol.toUpperCase();
    tipPx.textContent = money(m.current_price, getCurrency());
    const c = m.price_change_percentage_24h_in_currency;
    tipCh.textContent = percent(c);
    tipCh.className = c == null ? "" : c >= 0 ? "up" : "down";
    tipW = tip.offsetWidth; // once per content change, never per frame
    tipH = tip.offsetHeight;
  };
  const placeTip = () => {
    proj(pick);
    const gap = Math.min(cssSize(pick) * 0.3, 24) + 10;
    let x = sx + gap;
    if (x + tipW > w - 6) x = sx - gap - tipW; // flip to the left near the right edge
    x = clamp(x, 6, Math.max(6, w - tipW - 6));
    const y = clamp(sy - tipH / 2, 6, Math.max(6, h - tipH - 6));
    tip.style.transform = `translate(${x}px,${y}px)`;
  };
  const syncCursor = () => {
    canvas.style.cursor = diving >= 0 ? "default" : dragging ? "grabbing" : pick >= 0 ? "pointer" : "grab";
  };

  const setPick = (i: number) => {
    const prev = pick;
    pick = i;
    retarget();
    if (i >= 0 && diving < 0) {
      fillTip();
      placeTip();
    }
    tip.classList.toggle("is-on", i >= 0 && diving < 0);
    syncCursor();
    if (i !== prev) document.dispatchEvent(new CustomEvent<string | null>("scene:focus", { detail: i >= 0 ? data[i].id : null }));
  };

  const applyVisible = () => {
    if (!visIds || visIds.length >= idIndex.size) vis.fill(1);
    else {
      vis.fill(0);
      for (const id of visIds) {
        const i = idIndex.get(id);
        if (i !== undefined) vis[i] = 1;
      }
    }
    if (touchPick >= 0 && vis[touchPick] === 0) touchPick = -1;
    retarget();
    redraw();
  };

  const startTween = (dur: number, spin1: number, elev1: number, zoom1: number) => {
    tween.k = 0;
    tween.dur = dur;
    tween.spin0 = spin;
    tween.spin1 = spin1;
    tween.elev0 = elev;
    tween.elev1 = elev1;
    tween.zoom0 = zoom;
    tween.zoom1 = zoom1;
    spinVel = 0;
  };
  const cancelTween = () => {
    tween.k = 1;
    zoomTgt = zoom;
    spinVel = 0;
  };
  const reset = () => {
    if (diving >= 0 || tween.k < 1) return;
    spin = ((((spin + Math.PI) % TAU) + TAU) % TAU) - Math.PI; // same orientation, shortest way back
    startTween(RESET_S, 0, ELEV, 1);
    redraw();
  };
  const startDive = (i: number) => {
    if (diving >= 0 || !data[i]) return;
    diving = i;
    dragging = false;
    ptrs.clear();
    startTween(DIVE_S, spin, elev, DIVE_ZOOM);
    setPick(i);
    redraw();
  };

  const resize = (cw: number, ch: number) => {
    w = Math.max(1, cw);
    h = Math.max(1, ch);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const tanH = Math.tan((FOV * Math.PI) / 360);
    dist = (R * (Math.sin(ELEV) + 0.35)) / tanH; // whole disc fits the height
    stretch = Math.min(3, (dist * tanH * camera.aspect * 0.8) / R); // and it fills the width
    hf = Math.max(0.7, Math.min(1.2, h / 260));
    material.uniforms.uDist.value = dist;
    material.uniforms.uPx.value = renderer.getPixelRatio() * hf;
  };

  /** One simulation step. `snap` jumps every easing to its target (paused still frames). */
  const step = (dt: number, snap = false) => {
    t += dt;
    if (tween.k < 1) {
      tween.k = Math.min(1, tween.k + (snap ? 1 : dt / tween.dur));
      const k = tween.k * tween.k * (3 - 2 * tween.k);
      spin = tween.spin0 + (tween.spin1 - tween.spin0) * k;
      elev = tween.elev0 + (tween.elev1 - tween.elev0) * k;
      zoom = tween.zoom0 + (tween.zoom1 - tween.zoom0) * k;
      zoomTgt = zoom;
    } else {
      if (!dragging) {
        spin += spinVel * dt;
        spinVel = snap ? 0 : spinVel * Math.exp(-dt * INERTIA);
      }
      zoom += (zoomTgt - zoom) * (snap ? 1 : 1 - Math.exp(-dt * 10));
    }
    points.rotation.y = (t * TAU) / TURN_SECONDS + spin;
    const b = 1 + 0.02 * Math.sin((t * TAU) / 7);
    group.scale.set(stretch * b, b, b);
    scene.updateMatrixWorld();

    if (diving >= 0) {
      const k = tween.k * tween.k * (3 - 2 * tween.k);
      ctr.fromArray(pos, diving * 3).applyMatrix4(points.matrixWorld).multiplyScalar(k);
    }
    const k = 1 - Math.exp(-dt * 3);
    const calm = dragging || diving >= 0; // parallax rests during a drag and a dive
    pxCur += ((calm ? 0 : px) - pxCur) * k;
    pyCur += ((calm ? 0 : py) - pyCur) * k;
    const d = dist * zoom;
    const el = elev + pyCur * MAX_TILT;
    const az = pxCur * MAX_TILT;
    camera.position.set(ctr.x + d * Math.cos(el) * Math.sin(az), ctr.y + d * Math.sin(el), ctr.z + d * Math.cos(el) * Math.cos(az));
    camera.lookAt(ctr);
    camera.updateMatrixWorld();
    material.uniforms.uCam.value = d;

    const next = diving >= 0 ? diving : mouseIn && !dragging ? nearest(mx - rect.left, my - rect.top) : touchPick;
    if (next !== pick) setPick(next);
    if (pick >= 0 && diving < 0) placeTip();

    if (focus >= 0 && diving < 0 && !snap) {
      scaleTgt[focus] = HOT * (1 + 0.1 * Math.sin(t * 3.4)); // slow pulse while the table row is hovered
      fxEasing = true;
    }
    if (fxEasing) {
      const e = snap ? 1 : 1 - Math.exp(-dt * FX_RATE);
      let moving = false;
      for (let i = 0; i < N; i++) {
        const ds = scaleTgt[i] - scaleCur[i];
        const da = alphaTgt[i] - alphaCur[i];
        scaleCur[i] += ds * e;
        alphaCur[i] += da * e;
        if (Math.abs(ds) > 0.002 || Math.abs(da) > 0.002) moving = true;
      }
      if (!moving) {
        scaleCur.set(scaleTgt);
        alphaCur.set(alphaTgt);
      }
      scaleAttr.needsUpdate = true;
      alphaAttr.needsUpdate = true;
      fxEasing = !snap && (moving || (focus >= 0 && diving < 0));
    }
    if (easing) {
      const e = snap ? 1 : 1 - Math.exp(-dt * SETTLE);
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
      if (snap || !moving) {
        sizeCur.set(sizeTgt);
        colCur.set(colTgt);
        easing = false;
      }
      sizeAttr.needsUpdate = true;
      colAttr.needsUpdate = true;
    }

    if (diving >= 0 && tween.k >= 1 && !navigated) {
      navigated = true;
      void navigate(`/coin/${data[diving].id}`); // astro:before-swap disposes the scene
    }
  };

  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    const dt = last ? Math.min((now - last) / 1000, 0.1) : 0;
    last = now;
    step(dt);
    renderer.render(scene, camera);
  };

  // While paused the loop is off: changes snap and draw one still frame, coalesced per frame.
  const redraw = () => {
    if (raf || kicking || disposed) return;
    kicking = requestAnimationFrame(() => {
      kicking = 0;
      if (raf || disposed) return;
      step(0, true);
      renderer.render(scene, camera);
    });
  };

  const readRect = () => {
    rect = canvas.getBoundingClientRect();
  };
  const onWindowPointer = (e: PointerEvent) => {
    px = (e.clientX / vw) * 2 - 1;
    py = (e.clientY / vh) * 2 - 1;
  };
  const onWindowResize = () => {
    vw = innerWidth;
    vh = innerHeight;
    readRect();
  };
  const onPrefs = (e: Event) => {
    if ((e as CustomEvent<{ key: string }>).detail.key !== "theme") return;
    readTokens();
    writeColours();
    easing = true;
    redraw();
  };

  const pinchDist = () => {
    const [a, b] = [...ptrs.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  const track = (e: PointerEvent) => {
    if (e.pointerType === "touch") return;
    mouseIn = true;
    mx = e.clientX;
    my = e.clientY;
  };

  const onDown = (e: PointerEvent) => {
    if (diving >= 0 || (e.pointerType === "mouse" && e.button !== 0)) return;
    readRect();
    if (e.pointerType === "touch") mouseIn = false;
    track(e);
    cancelTween();
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.setPointerCapture(e.pointerId);
    if (ptrs.size === 1) {
      mode = e.pointerType === "touch" ? PENDING : DRAG;
      gx = e.clientX;
      gy = e.clientY;
      gt = e.timeStamp;
      travel = 0;
      accDx = 0;
      accT = e.timeStamp;
    } else if (ptrs.size === 2) {
      mode = PINCH;
      pinchD = pinchDist();
      dragging = true;
      touchPick = -1;
      syncCursor();
    }
  };

  const onMove = (e: PointerEvent) => {
    track(e);
    if (e.pointerType !== "touch") redraw();
    const p = ptrs.get(e.pointerId);
    if (!p) return;
    let dx = e.clientX - p.x;
    let dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (mode === PINCH) {
      const d = ptrs.size === 2 ? pinchDist() : 0;
      if (d > 0) {
        zoomTgt = clamp((zoomTgt * pinchD) / d, ZOOM_MIN, ZOOM_MAX);
        pinchD = d;
        redraw();
      }
      return;
    }
    travel = Math.max(travel, Math.hypot(e.clientX - gx, e.clientY - gy));
    if (mode === PENDING) {
      if (travel < 8) return;
      if (Math.abs(e.clientY - gy) > Math.abs(e.clientX - gx)) {
        mode = IGNORE; // mostly vertical: the page scrolls, not the galaxy
        return;
      }
      mode = DRAG;
      dx = e.clientX - gx;
      dy = e.clientY - gy;
    }
    if (mode !== DRAG) return;
    if (travel > TAP_PX && !dragging) {
      dragging = true;
      touchPick = -1;
      syncCursor();
    }
    spin += dx * SPIN_PX;
    elev = clamp(elev + dy * TILT_PX, ELEV_MIN, ELEV_MAX);
    accDx += dx;
    if (e.timeStamp - accT >= 16) {
      spinVel = clamp((accDx * SPIN_PX) / ((e.timeStamp - accT) / 1000), -3, 3);
      accDx = 0;
      accT = e.timeStamp;
    }
    redraw();
  };

  const onUp = (e: PointerEvent) => {
    if (!ptrs.delete(e.pointerId)) return;
    if (ptrs.size) {
      mode = IGNORE; // a finger remains after a pinch: it neither drags nor taps
      return;
    }
    const tap = e.type === "pointerup" && (mode === PENDING || mode === DRAG) && travel <= TAP_PX && e.timeStamp - gt < 500;
    if (mode !== DRAG || e.timeStamp - accT > 80) spinVel = 0; // inertia only when the finger left moving
    mode = NONE;
    dragging = false;
    syncCursor();
    if (tap) onTap(e);
    redraw();
  };

  /** Mouse click dives into the point under it; touch: first tap picks, second tap on the same point dives. */
  const onTap = (e: PointerEvent) => {
    const hit = nearest(e.clientX - rect.left, e.clientY - rect.top);
    if (e.pointerType !== "touch") {
      if (hit >= 0) startDive(hit);
      return;
    }
    if (hit >= 0) {
      lastEmptyTap = 0;
      if (hit === touchPick) startDive(hit);
      else touchPick = hit;
    } else {
      touchPick = -1;
      if (e.timeStamp - lastEmptyTap < 300) {
        lastEmptyTap = 0;
        reset();
      } else lastEmptyTap = e.timeStamp;
    }
  };

  const onWheel = (e: WheelEvent) => {
    if (diving >= 0) return;
    const next = clamp(zoomTgt * Math.exp(e.deltaY * (e.deltaMode === 1 ? 16 : 1) * (e.ctrlKey ? 0.01 : 0.0012)), ZOOM_MIN, ZOOM_MAX);
    if (next === zoomTgt) return; // at the limit the page scrolls instead
    e.preventDefault();
    cancelTween();
    zoomTgt = next;
    redraw();
  };

  const ro = new ResizeObserver(([entry]) => {
    resize(entry.contentRect.width, entry.contentRect.height);
    readRect();
    redraw();
  });
  ro.observe(parent);
  const ac = new AbortController();
  const { signal } = ac;
  addEventListener("pointermove", onWindowPointer, { passive: true, signal });
  addEventListener("resize", onWindowResize, { passive: true, signal });
  addEventListener("scroll", readRect, { passive: true, signal });
  document.addEventListener("prefs:change", onPrefs, { signal });
  canvas.addEventListener("pointerdown", onDown, { signal });
  canvas.addEventListener("pointermove", onMove, { passive: true, signal });
  canvas.addEventListener("pointerup", onUp, { signal });
  canvas.addEventListener("pointercancel", onUp, { signal });
  canvas.addEventListener(
    "pointerleave",
    (e) => {
      if (e.pointerType === "touch") return;
      mouseIn = false;
      redraw();
    },
    { signal },
  );
  canvas.addEventListener("wheel", onWheel, { passive: false, signal });
  canvas.addEventListener("dblclick", reset, { signal });
  resize(rect.width, rect.height); // once, before the observer's first callback

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
      data = markets;
      idIndex.clear();
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < N && i < markets.length; i++) {
        idIndex.set(markets[i].id, i);
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
      if (pick >= 0) fillTip(); // fresh price while the tooltip is open
      applyVisible(); // ids map to different indices after a new payload
    },
    /** Ids the table currently shows; all of them means nothing is filtered. */
    setVisible(ids: readonly string[]) {
      visIds = ids;
      if (!disposed) applyVisible();
    },
    /** Id of the table row under the pointer, or null. */
    setFocus(id: string | null) {
      if (disposed) return;
      focus = (id ? idIndex.get(id) : undefined) ?? -1;
      retarget();
      redraw();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      cancelAnimationFrame(kicking);
      raf = 0;
      ac.abort();
      ro.disconnect();
      ptrs.clear();
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
