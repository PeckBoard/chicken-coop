// Chicken Coop — the 3D page. One low-poly hen per card being worked on:
// emerges from the coop when work starts, wanders and pecks on tool activity,
// sits on a nest while the card is in a testing step, and walks back into the
// coop (and despawns) when the card lands on done/wont_do.
//
// Data arrives by polling the plugin's authed state endpoint through the
// parent-proxied fetch bridge (the page runs in a sandboxed iframe). When the
// page is opened standalone (window.parent === window) it switches to a demo
// roster so the scene can be developed and screenshotted without the app.
//
// Everything is procedural three.js primitives, textured by seeded canvas
// paints (wood grain, shingles, grass, straw, feathers) — no external assets.

import {
  AmbientLight,
  BoxGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  ExtrudeGeometry,
  Fog,
  Group,
  HemisphereLight,
  MathUtils,
  Mesh,
  MeshLambertMaterial,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Raycaster,
  RepeatWrapping,
  Scene,
  Shape,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  TorusGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { GATE_W, penLayout, penRoute, rectContains } from "./pens.js";
import { pecksToQueue, pollDelay } from "./visibility.js";

// ── Layout constants ──────────────────────────────────────────────────

const FIELD = { minX: -6, maxX: 8, minZ: -5.5, maxZ: 5.5 };
const COOP_POS = new Vector3(-9.6, 0, -2.2);
const DOOR_POS = new Vector3(-7.8, 0, -1.2); // just outside the coop door
const NEST_BASE = new Vector3(9.0, 0, -4.6); // nests fan out along +z
const NEST_GAP = 2.1;
const FENCE_X = 10.85; // blocked hens sulk here, facing out through the rails
const EGG_PATCH = new Vector3(7.1, 0, -2.8); // laid eggs collect by the nests
const MAX_LOOSE_EGGS = 12; // past a dozen, extras stack into a pile
const WALK_SPEED = 1.7;
const HOME_SPEED = 2.4;
const POLL_MS = 1000;
const MAX_QUEUED_PECKS = 3;
const FEED_COOLDOWN_S = 4; // min seconds between ground-click feed tosses
const FEED_KERNELS = 10;
const FEED_RADIUS = 5.5; // birds this close trot over for feed
const FEED_EXPIRE_S = 60; // uneaten kernels sink away after this long

// ── Small utilities ───────────────────────────────────────────────────

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PLUMAGE = [0xf2ead8, 0xa5692e, 0xc17a3f, 0x40392f, 0xd9b36c, 0xe8e2e0];

// Breed looks per session kind. Chicks reuse the parent breed's palette,
// tinted toward down-yellow.
const BREED_STYLE = {
  hen: { palettes: PLUMAGE, variant: "plain", scale: [0.9, 1.15] },
  rooster: {
    palettes: [0x8a3b1e, 0x6e2f18, 0x9c4a24],
    variant: "plain",
    scale: [1.14, 1.3],
  },
  barred: {
    palettes: [0x9a9a9a, 0x8b8b90],
    variant: "barred",
    scale: [0.9, 1.1],
  },
  bantam: {
    palettes: [0xf2ead8, 0xe9e2cf],
    variant: "plain",
    scale: [0.68, 0.78],
  },
};
const KIND_LABEL = {
  hen: "card",
  rooster: "chat",
  barred: "repeating task",
  bantam: "temp session",
  chick: "subagent",
};

// Popover-facing breed names, paired with KIND_LABEL for "what is this".
const BREED_NAME = {
  hen: "Hen",
  rooster: "Rooster",
  barred: "Barred hen",
  bantam: "Bantam",
  chick: "Chick",
};
/// Blend a plumage color toward chick-down yellow.
function chickTint(hex) {
  const c = new Color(hex);
  c.lerp(new Color(0xf7d867), 0.62);
  return c.getHex();
}

// Uncaught errors land in a DOM node so browser-driven tests can assert
// "no errors" without console access. The node exists from load with
// data-count="0".
window.__coopErrors = [];
const errorsEl = (() => {
  const n = document.createElement("div");
  n.id = "coop-errors";
  n.setAttribute("data-testid", "coop-errors");
  n.setAttribute("data-count", "0");
  n.style.display = "none";
  document.body.appendChild(n);
  return n;
})();
function noteError(msg) {
  window.__coopErrors.push(String(msg));
  errorsEl.textContent = window.__coopErrors.join("\n");
  errorsEl.setAttribute("data-count", String(window.__coopErrors.length));
  // Surface visibly so screenshots and outlines catch it (hidden when clean).
  errorsEl.style.cssText =
    "display:block;position:fixed;left:8px;bottom:8px;max-width:60ch;" +
    "background:#7a1f1f;color:#ffe9e9;font:12px/1.4 monospace;" +
    "padding:6px 10px;border-radius:6px;white-space:pre-wrap;z-index:99;";
}
window.addEventListener("error", (e) => noteError(e.message || e.type));
window.addEventListener("unhandledrejection", (e) =>
  noteError(
    (e.reason && (e.reason.stack || e.reason.message)) || "unhandledrejection",
  ),
);
// ?err=1: throw a probe error after load so tests can verify the capture
// plumbing end-to-end (the box must appear with data-count="1").
try {
  if (new URLSearchParams(location.search).get("err") === "1") {
    setTimeout(() => {
      throw new Error("demo error probe");
    }, 500);
  }
} catch (e) {
  /* URLSearchParams unavailable: skip the probe */
}

// ── Procedural sound (WebAudio, synthesized — no assets) ─────────────
//
// Oscillators and filtered noise only: soft clucks per peck (timbre by
// tool class), a rooster crow when a question badge first appears, and a
// faint daytime breeze with the odd distant songbird. Default muted; the
// corner toggle persists in localStorage, and the AudioContext is only
// created/resumed on a user gesture (autoplay policy). Volumes stay
// gentle — this page lives in a sidebar.

const sound = (() => {
  const KEY = "coop-sound"; // "on" | "off" (absent = muted)
  let muted = true;
  try {
    muted = localStorage.getItem(KEY) !== "on";
  } catch (e) {
    /* storage unavailable: stay muted */
  }
  let ctx = null;
  let master = null;
  let ambGain = null;
  let day = 1;
  let lastCluckAt = 0;

  function ensure() {
    if (ctx) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    try {
      ctx = new AC();
    } catch (e) {
      return false;
    }
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
    // Breeze bed: a 2s loop of low-passed brownish noise, scaled by the
    // daylight factor (near-silent at night).
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let v = 0;
    for (let i = 0; i < len; i++) {
      v = v * 0.985 + (Math.random() * 2 - 1) * 0.015;
      data[i] = v * 7;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 340;
    ambGain = ctx.createGain();
    ambGain.gain.value = 0;
    src.connect(lp);
    lp.connect(ambGain);
    ambGain.connect(master);
    src.start();
    // Occasional distant songbird, daytime only.
    setInterval(() => {
      if (muted || ctx.state !== "running" || day < 0.5) return;
      if (Math.random() < 0.45) chirp();
    }, 6000);
    return true;
  }

  // One syllable: a pitch-dropping oscillator with a fast attack/decay.
  function blip(t0, f0, f1, dur, peak, type) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g);
    g.connect(master);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }

  function chirp() {
    const t0 = ctx.currentTime + 0.05;
    const n = 2 + Math.floor(Math.random() * 3);
    const base = 2400 + Math.random() * 1200;
    for (let i = 0; i < n; i++) {
      blip(t0 + i * 0.14, base * 1.15, base, 0.09, 0.016, "sine");
    }
  }

  // Peck cluck, timbre by tool class: command = sharp double, edit = mid,
  // read = soft coo. Rate-limited so a busy flock isn't a hailstorm.
  function cluck(cls) {
    if (muted || !ctx || ctx.state !== "running") return;
    if (ctx.currentTime - lastCluckAt < 0.18) return;
    lastCluckAt = ctx.currentTime;
    const t = ctx.currentTime + 0.01;
    if (cls === "command") {
      blip(t, 1050, 430, 0.07, 0.12, "square");
      blip(t + 0.09, 960, 400, 0.06, 0.09, "square");
    } else if (cls === "edit") {
      blip(t, 760, 360, 0.09, 0.1, "triangle");
    } else if (cls === "read") {
      blip(t, 520, 300, 0.13, 0.055, "sine");
    } else {
      blip(t, 640, 330, 0.1, 0.07, "triangle");
    }
  }

  // Rooster crow: one sawtooth through a bandpass, four gain-pulsed
  // syllables with the last held and falling.
  function crow() {
    if (muted || !ctx || ctx.state !== "running") return;
    const t = ctx.currentTime + 0.02;
    const o = ctx.createOscillator();
    o.type = "sawtooth";
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1300;
    bp.Q.value = 2.2;
    const g = ctx.createGain();
    g.gain.value = 0.0001;
    o.connect(bp);
    bp.connect(g);
    g.connect(master);
    const syllables = [
      [t, 620, 0.15],
      [t + 0.2, 840, 0.15],
      [t + 0.4, 700, 0.15],
      [t + 0.62, 920, 0.5],
    ];
    for (const [st, f, d] of syllables) {
      o.frequency.setValueAtTime(f * 0.85, st);
      o.frequency.exponentialRampToValueAtTime(f, st + 0.05);
      g.gain.setValueAtTime(0.0001, st);
      g.gain.exponentialRampToValueAtTime(0.075, st + 0.035);
      g.gain.exponentialRampToValueAtTime(0.0001, st + d);
    }
    o.frequency.exponentialRampToValueAtTime(480, t + 1.12);
    o.start(t);
    o.stop(t + 1.2);
  }

  // Daylight 0..1 from the day/night cycle: scales the breeze bed and
  // gates the chirps.
  function setDay(d) {
    if (Math.abs(d - day) < 0.01) return;
    day = d;
    if (ambGain && !muted && ctx)
      ambGain.gain.setTargetAtTime(0.02 * day, ctx.currentTime, 0.5);
  }

  // Create/resume the context — must be called from a user gesture.
  function unlock() {
    if (muted || !ensure()) return;
    if (ctx.state !== "running") ctx.resume();
    ambGain.gain.setTargetAtTime(0.02 * day, ctx.currentTime, 0.5);
  }

  function toggle() {
    muted = !muted;
    try {
      localStorage.setItem(KEY, muted ? "off" : "on");
    } catch (e) {
      /* not persisted */
    }
    if (!muted) unlock();
    else if (ctx) ctx.suspend();
    return muted;
  }

  // Hidden-tab handling: park the audio thread while backgrounded and pick
  // it back up on return, but never spin up a context that didn't exist and
  // never override the mute choice.
  function suspend() {
    if (ctx && ctx.state === "running") ctx.suspend();
  }
  function resume() {
    if (!muted && ctx && ctx.state === "suspended") ctx.resume();
  }

  return {
    cluck,
    crow,
    setDay,
    toggle,
    unlock,
    suspend,
    resume,
    isMuted: () => muted,
  };
})();

// Corner mute toggle (default muted; choice persists). Created here, like
// the error box, so it exists in both the served page and the demo.
(() => {
  const b = document.createElement("button");
  b.id = "coop-sound";
  b.setAttribute("data-testid", "coop-sound");
  b.title = "Toggle sound";
  b.style.cssText =
    "position:fixed;right:12px;bottom:12px;z-index:20;width:34px;height:34px;" +
    "border:none;border-radius:8px;background:rgba(255,255,255,0.82);" +
    "font:16px system-ui,sans-serif;color:#333;cursor:pointer;";
  const paint = () => {
    b.textContent = sound.isMuted() ? "🔇" : "🔊";
    b.setAttribute("data-muted", sound.isMuted() ? "1" : "0");
  };
  b.addEventListener("click", () => {
    sound.toggle();
    paint();
  });
  document.body.appendChild(b);
  paint();
})();
// If sound was left on last visit, the context still needs a fresh gesture.
window.addEventListener("pointerdown", () => sound.unlock());
// ── Scene setup (guarded: headless fallback keeps state + mirror alive) ──

let renderer = null;
let scene = null;
let camera = null;
let sunLight = null;
let hemiLight = null;
let ambLight = null;
let moonLight = null;
let coopGlow = null; // {light, glassMat, doorMat} once buildCoop runs

function initScene() {
  try {
    renderer = new WebGLRenderer({ antialias: true });
  } catch (e) {
    return false;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
  document.getElementById("stage").appendChild(renderer.domElement);

  scene = new Scene();
  scene.background = new Color(0x87b5d8);
  scene.fog = new Fog(0x87b5d8, 30, 55);

  camera = new PerspectiveCamera(46, 1, 0.1, 120);
  camera.position.set(0, 9.4, 14.2);
  camera.lookAt(-0.3, 0.2, -1.6);

  hemiLight = new HemisphereLight(0xd8ecff, 0x6b8f4e, 0.85);
  scene.add(hemiLight);
  ambLight = new AmbientLight(0xffffff, 0.25);
  scene.add(ambLight);
  sunLight = new DirectionalLight(0xfff2d8, 1.6);
  sunLight.position.set(-9, 14, 8);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  sunLight.shadow.camera.left = -20;
  sunLight.shadow.camera.right = 20;
  sunLight.shadow.camera.top = 20;
  sunLight.shadow.camera.bottom = -20;
  scene.add(sunLight);
  // Cool fill that stands in for the moon once the sun is down.
  moonLight = new DirectionalLight(0x8fa8d8, 0);
  moonLight.position.set(7, 11, -6);
  scene.add(moonLight);

  buildWorld();
  onResize();
  window.addEventListener("resize", onResize);
  return true;
}

function onResize() {
  if (!renderer) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

// ── Day/night cycle (real local clock; ?hour= override) ──────────────
//
// The sun rides an east-west arc pinned to the local clock (up 6h–18h);
// sky, fog, hemisphere, and ambient colors blend between day, dusk-warm,
// and dim-blue night palettes as it crosses the horizon. After dark the
// coop's window and doorway glow warm and idle birds roost beside it.

// ?hour=<0..24, fractional> forces the time of day for demos/tests, e.g.
// ?hour=21.5 for night shots. Absent: the real local clock.
const HOUR_OVERRIDE = (() => {
  try {
    const v = new URLSearchParams(location.search).get("hour");
    const h = v === null ? NaN : parseFloat(v);
    return Number.isNaN(h) ? null : ((h % 24) + 24) % 24;
  } catch (e) {
    return null;
  }
})();

function localHour() {
  if (HOUR_OVERRIDE !== null) return HOUR_OVERRIDE;
  const d = new Date();
  return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
}

// Sun elevation proxy (-1..1, up 6h–18h) and the daylight factor
// (0 night → 1 day) with a soft dawn/dusk ramp around the horizon.
function sunElev(hour) {
  return Math.sin(((hour - 6) / 12) * Math.PI);
}

function dayFactor01(hour) {
  const t = Math.min(1, Math.max(0, (sunElev(hour) + 0.08) / 0.4));
  return t * t * (3 - 2 * t); // smoothstep
}

const SKY_DAY = new Color(0x87b5d8);
const SKY_NIGHT = new Color(0x0e1728);
const SKY_DUSK = new Color(0xd08a55);
const HEMI_DAY = new Color(0xd8ecff);
const HEMI_NIGHT = new Color(0x2c3a55);
const HEMI_GROUND_DAY = new Color(0x6b8f4e);
const HEMI_GROUND_NIGHT = new Color(0x1b241d);
const AMB_DAY = new Color(0xffffff);
const AMB_NIGHT = new Color(0x33415e);
const SUN_DAY = new Color(0xfff2d8);
const SUN_DUSK = new Color(0xff9a4d);
const GLOW_WARM = new Color(0xffb066);
const _sky = new Color();
const _tmp = new Color();

let isNight = false; // roosting gate, read by Chicken.update
let prevNightAttr = null;

function updateDayNight() {
  const hour = localHour();
  const day = dayFactor01(hour);
  const elev = sunElev(hour);
  // Dusk warmth peaks while the sun sits on the horizon.
  const dusk = Math.max(0, 1 - Math.abs(elev) / 0.25);
  isNight = day < 0.3;
  window.__coopDay = day;
  if (prevNightAttr !== isNight) {
    prevNightAttr = isNight;
    document.body.setAttribute("data-coop-night", isNight ? "1" : "0");
  }
  sound.setDay(day);
  if (!renderer) return;

  _sky.copy(SKY_NIGHT).lerp(SKY_DAY, day);
  _sky.lerp(SKY_DUSK, dusk * 0.55);
  scene.background.copy(_sky);
  scene.fog.color.copy(_sky);

  hemiLight.color.copy(_tmp.copy(HEMI_NIGHT).lerp(HEMI_DAY, day));
  hemiLight.groundColor.copy(
    _tmp.copy(HEMI_GROUND_NIGHT).lerp(HEMI_GROUND_DAY, day),
  );
  hemiLight.intensity = 0.28 + 0.57 * day;
  ambLight.color.copy(_tmp.copy(AMB_NIGHT).lerp(AMB_DAY, day));
  ambLight.intensity = 0.15 + 0.1 * day;

  // Sun arc across the sky; parked low (and off) through the night.
  const th = ((hour - 6) / 12) * Math.PI;
  sunLight.position.set(
    -Math.cos(th) * 14,
    Math.max(elev, 0.06) * 13 + 1.5,
    8 - dusk * 3,
  );
  sunLight.intensity = 1.6 * day + 0.25 * dusk;
  sunLight.color.copy(_tmp.copy(SUN_DAY).lerp(SUN_DUSK, dusk));
  moonLight.intensity = 0.32 * (1 - day);

  // Warm light from the coop window/door after dark.
  const glow = 1 - day;
  if (coopGlow) {
    coopGlow.light.intensity = glow * 1.35;
    coopGlow.glassMat.emissive.copy(GLOW_WARM).multiplyScalar(glow * 0.95);
    coopGlow.doorMat.emissive.copy(GLOW_WARM).multiplyScalar(glow * 0.8);
  }
}
function lambert(color) {
  return new MeshLambertMaterial({ color });
}

function lambertMap(map) {
  return new MeshLambertMaterial({ map });
}

function box(w, h, d, color) {
  const m = new Mesh(new BoxGeometry(w, h, d), lambert(color));
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function boxMap(w, h, d, mat) {
  const m = new Mesh(new BoxGeometry(w, h, d), mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

// ── Procedural canvas textures (seeded, stable across reloads) ────────

function shadeHex(hex, delta) {
  const r = Math.min(255, Math.max(0, ((hex >> 16) & 255) + delta));
  const g = Math.min(255, Math.max(0, ((hex >> 8) & 255) + delta));
  const b = Math.min(255, Math.max(0, (hex & 255) + delta));
  return (r << 16) | (g << 8) | b;
}

function cssHex(hex) {
  return "#" + hex.toString(16).padStart(6, "0");
}

function makeTexture(w, h, draw, repeatX = 1, repeatY = 1) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  draw(canvas.getContext("2d"), w, h);
  const tex = new CanvasTexture(canvas);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// Wood planks: per-plank tint, wavy grain strokes, a knot here and there,
// dark gap shadows at the seams.
function drawWood(ctx, w, h, base, planks, vertical, rnd) {
  ctx.fillStyle = cssHex(base);
  ctx.fillRect(0, 0, w, h);
  const across = vertical ? w : h;
  const along = vertical ? h : w;
  const pw = across / planks;
  for (let i = 0; i < planks; i++) {
    ctx.fillStyle = cssHex(shadeHex(base, Math.round((rnd() - 0.5) * 30)));
    if (vertical) ctx.fillRect(i * pw, 0, pw, h);
    else ctx.fillRect(0, i * pw, w, pw);
    for (let g = 0; g < 6; g++) {
      ctx.strokeStyle = `rgba(52,30,14,${0.1 + rnd() * 0.16})`;
      ctx.lineWidth = 0.6 + rnd() * 1.1;
      const off = i * pw + (0.1 + 0.8 * rnd()) * pw;
      const wob = 1 + rnd() * 2.5;
      const freq = 0.7 + rnd() * 0.5;
      ctx.beginPath();
      for (let t = 0; t <= 8; t++) {
        const a = (t / 8) * along;
        const c = off + Math.sin(t * freq + g) * wob;
        if (t === 0) ctx.moveTo(vertical ? c : a, vertical ? a : c);
        else ctx.lineTo(vertical ? c : a, vertical ? a : c);
      }
      ctx.stroke();
    }
    if (rnd() < 0.55) {
      const ka = (0.15 + 0.7 * rnd()) * along;
      const kc = i * pw + (0.25 + 0.5 * rnd()) * pw;
      ctx.strokeStyle = "rgba(45,25,10,0.5)";
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.ellipse(
        vertical ? kc : ka,
        vertical ? ka : kc,
        2.6 + rnd() * 2,
        1.7 + rnd() * 1.4,
        rnd() * 3,
        0,
        Math.PI * 2,
      );
      ctx.stroke();
    }
    ctx.fillStyle = "rgba(30,16,6,0.42)";
    if (vertical) ctx.fillRect(i * pw - 0.8, 0, 1.6, h);
    else ctx.fillRect(0, i * pw - 0.8, w, 1.6);
  }
}

// Grass tile: mottled tone blobs plus individual leaning blades. Everything
// near an edge is drawn wrapped so the repeat has no visible seam.
function drawGrass(ctx, w, h, rnd) {
  ctx.fillStyle = "#79a659";
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 70; i++) {
    const x = rnd() * w;
    const y = rnd() * h;
    const r = 8 + rnd() * 22;
    ctx.fillStyle =
      rnd() < 0.5
        ? `rgba(86,128,58,${0.1 + rnd() * 0.12})`
        : `rgba(148,186,102,${0.08 + rnd() * 0.1})`;
    for (const ox of [-w, 0, w])
      for (const oy of [-h, 0, h]) {
        ctx.beginPath();
        ctx.ellipse(
          x + ox,
          y + oy,
          r,
          r * (0.5 + rnd() * 0.5),
          rnd() * 3,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
  }
  for (let i = 0; i < 420; i++) {
    const x = rnd() * w;
    const y = rnd() * h;
    const len = 3 + rnd() * 5;
    const lean = (rnd() - 0.5) * 4;
    ctx.strokeStyle =
      rnd() < 0.5
        ? `rgba(62,100,40,${0.25 + rnd() * 0.3})`
        : `rgba(160,198,110,${0.2 + rnd() * 0.3})`;
    ctx.lineWidth = 0.7 + rnd() * 0.6;
    for (const ox of [-w, 0, w])
      for (const oy of [-h, 0, h]) {
        ctx.beginPath();
        ctx.moveTo(x + ox, y + oy);
        ctx.quadraticCurveTo(
          x + ox + lean * 0.4,
          y + oy - len * 0.6,
          x + ox + lean,
          y + oy - len,
        );
        ctx.stroke();
      }
  }
}

// Bare-earth disc that fades out at the rim so it blends into the grass.
function drawDirt(ctx, w, h, rnd) {
  const cx = w / 2;
  const cy = h / 2;
  const grad = ctx.createRadialGradient(cx, cy, w * 0.1, cx, cy, w * 0.5);
  grad.addColorStop(0, "rgba(178,148,102,0.95)");
  grad.addColorStop(0.75, "rgba(170,140,96,0.8)");
  grad.addColorStop(1, "rgba(165,136,92,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 60; i++) {
    const a = rnd() * Math.PI * 2;
    const d = rnd() * w * 0.42;
    const x = cx + Math.cos(a) * d;
    const y = cy + Math.sin(a) * d;
    const fade = Math.max(0, 1 - d / (w * 0.48));
    ctx.fillStyle =
      rnd() < 0.6
        ? `rgba(140,110,70,${0.35 * fade})`
        : `rgba(205,180,135,${0.3 * fade})`;
    ctx.beginPath();
    ctx.ellipse(
      x,
      y,
      1.5 + rnd() * 3.5,
      1 + rnd() * 2.5,
      rnd() * 3,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
}

// Staggered rows of round-bottomed shingle tabs with a shadow line per row.
function drawShingles(ctx, w, h, rnd) {
  ctx.fillStyle = "#6e3820";
  ctx.fillRect(0, 0, w, h);
  const rows = 5;
  const cols = 6;
  const rh = h / rows;
  const cw = w / cols;
  for (let r = 0; r < rows; r++) {
    const y = r * rh;
    const offset = (r % 2) * 0.5;
    for (let c = -1; c < cols; c++) {
      const x = (c + offset) * cw;
      ctx.fillStyle = cssHex(
        shadeHex(0x7c3f24, Math.round((rnd() - 0.5) * 34)),
      );
      ctx.beginPath();
      ctx.moveTo(x + 1, y);
      ctx.lineTo(x + cw - 1, y);
      ctx.lineTo(x + cw - 1, y + rh * 0.72);
      ctx.quadraticCurveTo(x + cw / 2, y + rh * 1.05, x + 1, y + rh * 0.72);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = "rgba(20,8,4,0.35)";
    ctx.fillRect(0, y - 1, w, 2.2);
  }
}

// Criss-crossed straw strands over a golden base.
function drawStraw(ctx, w, h, rnd) {
  ctx.fillStyle = "#c9a24a";
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 160; i++) {
    const x = rnd() * w;
    const y = rnd() * h;
    const a = rnd() * Math.PI * 2;
    const len = 6 + rnd() * 14;
    ctx.strokeStyle =
      rnd() < 0.5
        ? `rgba(122,88,30,${0.3 + rnd() * 0.3})`
        : `rgba(235,205,120,${0.3 + rnd() * 0.3})`;
    ctx.lineWidth = 0.8 + rnd() * 0.8;
    for (const ox of [-w, 0, w])
      for (const oy of [-h, 0, h]) {
        ctx.beginPath();
        ctx.moveTo(x + ox, y + oy);
        ctx.lineTo(x + ox + Math.cos(a) * len, y + oy + Math.sin(a) * len);
        ctx.stroke();
      }
  }
}

// Soft scalloped feather rows, tinted around the plumage color.
function drawFeathers(ctx, w, h, plumage, rnd, variant) {
  ctx.fillStyle = cssHex(plumage);
  ctx.fillRect(0, 0, w, h);
  if (variant === "barred") {
    // Plymouth-Rock barring: alternating soft light/dark bands under the
    // scallops.
    const bands = 8;
    for (let i = 0; i < bands; i++) {
      ctx.fillStyle = i % 2 ? "rgba(246,244,238,0.55)" : "rgba(38,38,44,0.45)";
      ctx.fillRect(0, (i * h) / bands, w, h / bands / 1.55);
    }
  }
  const rows = 6;
  const cols = 6;
  const rh = h / rows;
  for (let r = 0; r < rows; r++) {
    const offset = (r % 2) * 0.5;
    for (let c = -1; c < cols; c++) {
      const cx = (c + offset + 0.5) * (w / cols);
      const cy = r * rh + rh * 0.55;
      ctx.strokeStyle = `rgba(0,0,0,${0.07 + rnd() * 0.07})`;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(cx, cy, w / 12, 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.stroke();
      ctx.strokeStyle = `rgba(255,255,255,${0.05 + rnd() * 0.06})`;
      ctx.beginPath();
      ctx.arc(cx, cy - 2, w / 12, 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.stroke();
    }
  }
}

let TEX = null;
function ensureTextures() {
  if (TEX) return TEX;
  const rnd = mulberry32(20260723);
  TEX = {
    grass: makeTexture(256, 256, (c, w, h) => drawGrass(c, w, h, rnd), 12, 8),
    dirt: makeTexture(128, 128, (c, w, h) => drawDirt(c, w, h, rnd)),
    wall: makeTexture(
      256,
      256,
      (c, w, h) => drawWood(c, w, h, 0xa4653a, 7, true, rnd),
      2,
      1,
    ),
    gable: makeTexture(256, 256, (c, w, h) =>
      drawWood(c, w, h, 0xb27547, 6, true, rnd),
    ),
    floor: makeTexture(128, 128, (c, w, h) =>
      drawWood(c, w, h, 0x8f6b4a, 4, false, rnd),
    ),
    roof: makeTexture(256, 256, (c, w, h) => drawShingles(c, w, h, rnd), 3, 2),
    post: makeTexture(64, 128, (c, w, h) =>
      drawWood(c, w, h, 0x9b8262, 2, true, rnd),
    ),
    rail: makeTexture(
      256,
      64,
      (c, w, h) => drawWood(c, w, h, 0x9b8262, 2, false, rnd),
      5,
      1,
    ),
    straw: makeTexture(128, 128, (c, w, h) => drawStraw(c, w, h, rnd), 2, 2),
  };
  return TEX;
}

// ── World: ground, coop, fence, nests, greenery ───────────────────────

function buildWorld() {
  const T = ensureTextures();

  const ground = new Mesh(new PlaneGeometry(70, 46), lambertMap(T.grass));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Bare patches where the hens scratch: by the door, mid-field, the nests.
  const dirtPatch = (r, x, z, rot) => {
    const m = new Mesh(
      new CircleGeometry(r, 26),
      new MeshLambertMaterial({
        map: T.dirt,
        transparent: true,
        depthWrite: false,
      }),
    );
    m.rotation.set(-Math.PI / 2, 0, rot);
    m.position.set(x, 0.012, z);
    m.receiveShadow = true;
    scene.add(m);
  };
  dirtPatch(1.6, DOOR_POS.x + 1.2, DOOR_POS.z + 0.3, 0.4);
  dirtPatch(1.1, 1.4, 1.9, 2.1);
  dirtPatch(0.9, 4.9, -2.4, 1.2);
  dirtPatch(1.4, NEST_BASE.x - 0.4, NEST_BASE.z + 3.4, 2.8);

  buildCoop(T);
  buildFence(T);
  buildStatsBoard(T);

  // Grass tufts, bushes, flowers — deterministic scatter.
  const rnd = mulberry32(20260723);
  const tuftG = new ConeGeometry(0.09, 0.34, 5);
  const tuftMats = [lambert(0x5e8f3e), lambert(0x6ea04a), lambert(0x548438)];
  for (let i = 0; i < 150; i++) {
    const t = new Mesh(tuftG, tuftMats[i % 3]);
    const s = 0.7 + rnd() * 0.9;
    t.scale.setScalar(s);
    t.position.set(-12 + rnd() * 24, 0.17 * s, -6.8 + rnd() * 13);
    t.rotation.y = rnd() * Math.PI;
    t.rotation.z = (rnd() - 0.5) * 0.24;
    t.castShadow = true;
    scene.add(t);
  }
  const bushMats = [lambert(0x4c7a34), lambert(0x5c8a3e)];
  for (let i = 0; i < 5; i++) {
    const b = new Group();
    for (let k = 0; k < 3 + (i % 2); k++) {
      const r = 0.35 + rnd() * 0.35;
      const m = new Mesh(new SphereGeometry(r, 9, 7), bushMats[(i + k) % 2]);
      m.position.set((rnd() - 0.5) * 0.9, r * 0.55, (rnd() - 0.5) * 0.5);
      m.scale.y = 0.75;
      m.castShadow = true;
      b.add(m);
    }
    b.position.set(-10.5 + i * 5.2 + rnd() * 1.5, 0, -6.55 + rnd() * 0.5);
    scene.add(b);
  }
  const petalM = [
    lambert(0xe86a6a),
    lambert(0xf0d75e),
    lambert(0xffffff),
    lambert(0xc98ad4),
  ];
  const petalG = new SphereGeometry(0.09, 6, 5);
  const stemG = new CylinderGeometry(0.02, 0.02, 0.3, 5);
  const stemM = lambert(0x4d7a33);
  for (let i = 0; i < 30; i++) {
    const f = new Group();
    const stem = new Mesh(stemG, stemM);
    stem.position.y = 0.15;
    f.add(stem);
    const head = new Mesh(petalG, petalM[i % 4]);
    head.position.y = 0.34;
    f.add(head);
    f.position.set(-11.5 + rnd() * 23, 0, -6.6 + rnd() * 12.6);
    scene.add(f);
  }
}

// The henhouse: stilt foundation, plank walls with corner trim, shingled
// gable roof, framed doorway with the door swung open, a four-pane window,
// gable vent, nesting-box bump-out, cleated ramp, weathervane, hay pile.
// The doorway and ramp stay aligned with DOOR_POS (spawn/despawn point).
function buildCoop(T) {
  const coop = new Group();
  const wallMat = lambertMap(T.wall);
  const gableMat = lambertMap(T.gable);
  const floorMat = lambertMap(T.floor);
  const roofMat = lambertMap(T.roof);
  const trimMat = lambert(0xe9dcc3);
  const darkMat = lambert(0x241610);

  for (const [sx, sz] of [
    [-1.45, -1.45],
    [1.45, -1.45],
    [-1.45, 1.45],
    [1.45, 1.45],
  ]) {
    const stilt = new Mesh(new CylinderGeometry(0.09, 0.12, 0.68, 8), floorMat);
    stilt.position.set(sx, 0.34, sz);
    stilt.castShadow = true;
    coop.add(stilt);
  }
  const slab = boxMap(3.7, 0.16, 3.7, floorMat);
  slab.position.y = 0.68;
  coop.add(slab);

  const body = boxMap(3.4, 1.9, 3.4, wallMat);
  body.position.y = 1.71;
  coop.add(body);
  for (const [sx, sz] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ]) {
    const corner = boxMap(0.12, 1.94, 0.12, trimMat);
    corner.position.set(sx * 1.66, 1.71, sz * 1.66);
    coop.add(corner);
  }

  // Gable roof, ridge along x: slabs overhang the eaves and the gables.
  const rise = 1.2;
  const eaveZ = 1.98;
  const pitch = Math.atan2(rise, eaveZ);
  const slope = Math.hypot(eaveZ, rise);
  for (const side of [-1, 1]) {
    const slabR = boxMap(4.35, 0.09, slope + 0.12, roofMat);
    slabR.position.set(0, 3.2, side * (eaveZ / 2));
    slabR.rotation.x = side * pitch;
    coop.add(slabR);
  }
  const ridge = boxMap(4.4, 0.1, 0.24, floorMat);
  ridge.position.y = 3.82;
  coop.add(ridge);

  const tri = new Shape();
  tri.moveTo(-1.7, 0);
  tri.lineTo(1.7, 0);
  tri.lineTo(0, rise);
  tri.closePath();
  const triG = new ExtrudeGeometry(tri, { depth: 0.1, bevelEnabled: false });
  for (const side of [-1, 1]) {
    const gableEnd = new Mesh(triG, gableMat);
    gableEnd.rotation.y = (side * Math.PI) / 2;
    gableEnd.position.set(side * 1.62, 2.66, 0);
    gableEnd.castShadow = true;
    coop.add(gableEnd);
  }

  const ventRing = new Mesh(
    new CylinderGeometry(0.19, 0.19, 0.05, 16),
    trimMat,
  );
  ventRing.rotation.z = Math.PI / 2;
  ventRing.position.set(1.74, 3.12, 0);
  coop.add(ventRing);
  const vent = new Mesh(new CylinderGeometry(0.14, 0.14, 0.07, 16), darkMat);
  vent.rotation.z = Math.PI / 2;
  vent.position.set(1.76, 3.12, 0);
  coop.add(vent);

  // Doorway (kept at the same spot so DOOR_POS still lines up).
  const doorMat = new MeshLambertMaterial({ color: 0x241610 });
  const opening = boxMap(0.06, 1.15, 0.9, doorMat);
  opening.position.set(1.71, 1.34, 1.0);
  coop.add(opening);
  for (const side of [-1, 1]) {
    const jamb = boxMap(0.1, 1.3, 0.1, trimMat);
    jamb.position.set(1.73, 1.36, 1.0 + side * 0.5);
    coop.add(jamb);
  }
  const lintel = boxMap(0.1, 0.1, 1.1, trimMat);
  lintel.position.set(1.73, 1.97, 1.0);
  coop.add(lintel);
  const hinge = new Group();
  hinge.position.set(1.74, 1.34, 0.53);
  const panel = boxMap(0.05, 1.1, 0.84, gableMat);
  panel.position.set(0, 0, 0.43);
  hinge.add(panel);
  for (const by of [-0.42, 0.42]) {
    const brace = boxMap(0.02, 0.08, 0.78, floorMat);
    brace.position.set(0.035, by, 0.43);
    hinge.add(brace);
  }
  const diag = boxMap(0.02, 0.08, 0.9, floorMat);
  diag.position.set(0.035, 0, 0.43);
  diag.rotation.x = 0.62;
  hinge.add(diag);
  hinge.rotation.y = 1.15;
  coop.add(hinge);

  // Four-pane window on the front wall.
  const winFrame = boxMap(0.08, 0.86, 0.86, trimMat);
  winFrame.position.set(1.72, 1.78, -0.55);
  coop.add(winFrame);
  const glassMat = new MeshLambertMaterial({ color: 0xaed2e8 });
  const glass = new Mesh(new BoxGeometry(0.04, 0.7, 0.7), glassMat);
  glass.position.set(1.745, 1.78, -0.55);
  coop.add(glass);
  const munH = boxMap(0.03, 0.05, 0.7, trimMat);
  munH.position.set(1.77, 1.78, -0.55);
  coop.add(munH);
  const munV = boxMap(0.03, 0.7, 0.05, trimMat);
  munV.position.set(1.77, 1.78, -0.55);
  coop.add(munV);
  const sill = boxMap(0.12, 0.07, 1.0, trimMat);
  sill.position.set(1.74, 1.32, -0.55);
  coop.add(sill);

  // Nesting-box bump-out on the camera-facing wall.
  const nestBox = boxMap(1.5, 0.62, 0.5, gableMat);
  nestBox.position.set(-0.55, 1.45, 1.9);
  coop.add(nestBox);
  const nestLid = boxMap(1.6, 0.06, 0.62, roofMat);
  nestLid.position.set(-0.55, 1.83, 1.92);
  nestLid.rotation.x = 0.42;
  coop.add(nestLid);
  for (const bx of [-1.2, 0.1]) {
    const bracket = boxMap(0.08, 0.3, 0.3, floorMat);
    bracket.position.set(bx, 1.08, 1.8);
    coop.add(bracket);
  }

  // Cleated ramp from the doorway down to the ground at DOOR_POS.
  const ramp = new Group();
  ramp.position.set(2.6, 0.4, 1.0);
  ramp.rotation.z = -0.4;
  const plank = boxMap(1.9, 0.07, 0.85, floorMat);
  ramp.add(plank);
  const cleatMat = lambert(0x6f5236);
  for (let i = -2; i <= 2; i++) {
    const cleat = boxMap(0.06, 0.035, 0.8, cleatMat);
    cleat.position.set(i * 0.36, 0.05, 0);
    ramp.add(cleat);
  }
  coop.add(ramp);

  // Weathervane on the ridge.
  const pole = new Mesh(new CylinderGeometry(0.018, 0.018, 0.55, 6), darkMat);
  pole.position.set(0, 4.05, 0);
  coop.add(pole);
  const vane = new Group();
  vane.position.set(0, 4.22, 0);
  vane.rotation.y = 0.7;
  const shaft = boxMap(0.5, 0.025, 0.025, darkMat);
  vane.add(shaft);
  const tip = new Mesh(new ConeGeometry(0.05, 0.14, 6), darkMat);
  tip.rotation.z = -Math.PI / 2;
  tip.position.x = 0.3;
  vane.add(tip);
  const fin = boxMap(0.025, 0.14, 0.12, darkMat);
  fin.position.x = -0.26;
  vane.add(fin);
  coop.add(vane);
  const ball = new Mesh(new SphereGeometry(0.035, 8, 6), trimMat);
  ball.position.set(0, 4.35, 0);
  coop.add(ball);

  // Hay spilling off the ramp.
  const strawMat = lambertMap(T.straw);
  for (const [hx, hz, hr] of [
    [3.9, 1.7, 0.42],
    [4.25, 1.35, 0.3],
    [3.6, 1.15, 0.26],
  ]) {
    const hay = new Mesh(new SphereGeometry(hr, 10, 8), strawMat);
    hay.position.set(hx, hr * 0.45, hz);
    hay.scale.y = 0.55;
    hay.castShadow = true;
    coop.add(hay);
  }

  // Night glow: a warm lamp inside the coop; updateDayNight drives its
  // intensity and the window/door emissives from the daylight factor.
  const glowLight = new PointLight(0xffb066, 0, 11, 2);
  glowLight.position.set(2.3, 1.7, 0.2);
  coop.add(glowLight);
  coopGlow = { light: glowLight, glassMat, doorMat };
  coop.position.copy(COOP_POS);
  scene.add(coop);
}

// Split-rail fence along the back and right, wood-grain textured.
function buildFence(T) {
  const postMat = lambertMap(T.post);
  const railMat = lambertMap(T.rail);
  const postG = new CylinderGeometry(0.07, 0.09, 1.15, 7);
  const capG = new ConeGeometry(0.1, 0.14, 7);

  const addPost = (x, z) => {
    const p = new Mesh(postG, postMat);
    p.position.set(x, 0.57, z);
    p.castShadow = true;
    scene.add(p);
    const cap = new Mesh(capG, postMat);
    cap.position.set(x, 1.2, z);
    cap.castShadow = true;
    scene.add(cap);
  };
  const addRails = (len, x, z, rotY) => {
    for (const y of [0.88, 0.48]) {
      const r = new Mesh(new BoxGeometry(len, 0.1, 0.055), railMat);
      r.position.set(x, y, z);
      r.rotation.y = rotY;
      r.castShadow = true;
      r.receiveShadow = true;
      scene.add(r);
    }
  };

  for (let x = -11.5; x <= 11.5; x += 2.6) addPost(x, -7.2);
  addRails(23.5, 0, -7.2, 0);
  for (let z = -4.6; z <= 6.0; z += 2.6) addPost(11.5, z);
  addRails(13.3, 11.5, -0.55, Math.PI / 2);
}

// ── Project pens ──────────────────────────────────────────────────────
//
// When the live birds span 2+ projects the field splits into fenced pens,
// one per project (layout math in pens.js). Coop and nests stay shared:
// birds path through their pen's gate and along the commons corridor.
// The pen area stops short of the egg patch so the east lane to the
// nests stays open.

const PEN_FIELD = {
  minX: FIELD.minX,
  maxX: 6.4,
  minZ: FIELD.minZ,
  maxZ: FIELD.maxZ,
};
let penState = null; // {sig, layout, byKey} — null: single-project open run
let penGroup = null; // fence/gate/sign meshes for the current layout

/// The pen a bird belongs to (null = commons). Chicks stay in their
/// parent's pen.
function birdPen(c) {
  if (!penState) return null;
  if (c.kind === "chick" && c.parentId && flock[c.parentId])
    return birdPen(flock[c.parentId]);
  return penState.byKey[c.project] || null;
}

/// The rectangle a bird wanders in: its pen, the commons strip, or the
/// whole field when no pens are up.
function wanderRect(c) {
  if (!penState) return FIELD;
  const pen = birdPen(c);
  return pen ? pen.rect : penState.layout.commons;
}

// Small procedural wooden sign: post plus a wood-grain board with the
// project name painted on, facing the camera.
function buildPenSign(text) {
  const T = ensureTextures();
  const g = new Group();
  const post = new Mesh(
    new CylinderGeometry(0.05, 0.065, 1.05, 7),
    lambertMap(T.post),
  );
  post.position.y = 0.52;
  post.castShadow = true;
  g.add(post);
  const rnd = mulberry32(hashStr("sign:" + text));
  const tex = makeTexture(256, 96, (ctx, w, h) => {
    drawWood(ctx, w, h, 0x8a6a44, 3, false, rnd);
    ctx.fillStyle = "#2b1c0f";
    ctx.font = "700 40px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const t = text.length > 13 ? text.slice(0, 12) + "…" : text;
    ctx.fillText(t, w / 2, h / 2 + 2);
  });
  const board = new Mesh(new BoxGeometry(1.45, 0.5, 0.06), lambertMap(tex));
  board.position.y = 1.05;
  board.castShadow = true;
  g.add(board);
  return g;
}

// Fences, swung-open gates, and signs for a pen layout. Same split-rail
// style as the outer fence, a touch shorter so the field stays readable.
function buildPenFences(layout) {
  const T = ensureTextures();
  penGroup = new Group();
  const postMat = lambertMap(T.post);
  const railMat = lambertMap(T.rail);
  const postG = new CylinderGeometry(0.06, 0.08, 0.92, 7);
  const capG = new ConeGeometry(0.085, 0.12, 7);
  const posted = {}; // shared corner posts between pens draw once
  const addPost = (x, z) => {
    const key = x.toFixed(2) + "," + z.toFixed(2);
    if (posted[key]) return;
    posted[key] = true;
    const p = new Mesh(postG, postMat);
    p.position.set(x, 0.46, z);
    p.castShadow = true;
    penGroup.add(p);
    const cap = new Mesh(capG, postMat);
    cap.position.set(x, 0.97, z);
    penGroup.add(cap);
  };
  // Axis-aligned fence run: posts every ~2.2 plus both ends, two rails.
  const addRun = (x0, z0, x1, z1) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    if (len < 0.05) return;
    const n = Math.max(1, Math.ceil(len / 2.2));
    for (let i = 0; i <= n; i++)
      addPost(x0 + ((x1 - x0) * i) / n, z0 + ((z1 - z0) * i) / n);
    const rotY = Math.abs(x1 - x0) >= Math.abs(z1 - z0) ? 0 : Math.PI / 2;
    for (const y of [0.7, 0.36]) {
      const r = new Mesh(new BoxGeometry(len, 0.09, 0.05), railMat);
      r.position.set((x0 + x1) / 2, y, (z0 + z1) / 2);
      r.rotation.y = rotY;
      r.castShadow = true;
      r.receiveShadow = true;
      penGroup.add(r);
    }
  };
  const pens = layout.pens;
  const block = pens[0].rect;
  addRun(block.minX, block.minZ, block.minX, block.maxZ); // west side
  addRun(block.minX, block.minZ, pens[pens.length - 1].rect.maxX, block.minZ); // shared north side
  for (const pen of pens) {
    const r = pen.rect;
    addRun(r.maxX, r.minZ, r.maxX, r.maxZ); // east side (shared divider)
    // South fence, split around the gate.
    addRun(r.minX, r.maxZ, pen.gate.x - GATE_W / 2, r.maxZ);
    addRun(pen.gate.x + GATE_W / 2, r.maxZ, r.maxX, r.maxZ);
    // Gate leaf, hinged on the west gap post, swung open toward the
    // commons so the opening reads at a glance.
    const leaf = new Group();
    for (const y of [0.62, 0.3]) {
      const bar = new Mesh(new BoxGeometry(GATE_W - 0.12, 0.08, 0.04), railMat);
      bar.position.set((GATE_W - 0.12) / 2, y, 0);
      leaf.add(bar);
    }
    const diag = new Mesh(new BoxGeometry(GATE_W - 0.16, 0.07, 0.035), railMat);
    diag.position.set((GATE_W - 0.12) / 2, 0.46, 0);
    diag.rotation.z = 0.32;
    leaf.add(diag);
    const stile = new Mesh(new BoxGeometry(0.06, 0.62, 0.05), railMat);
    stile.position.set(GATE_W - 0.15, 0.46, 0);
    leaf.add(stile);
    leaf.traverse((o) => (o.castShadow = true));
    leaf.position.set(pen.gate.x - GATE_W / 2, 0, r.maxZ);
    leaf.rotation.y = -1.2;
    penGroup.add(leaf);
    const sign = buildPenSign(pen.key);
    sign.position.set(pen.gate.x + GATE_W / 2 + 0.4, 0, r.maxZ + 0.2);
    penGroup.add(sign);
  }
  scene.add(penGroup);
}

/// Re-derive the pen layout from the roster. Only the project KEY SET
/// triggers a re-fence (counts shape pen widths at that moment), so pens
/// never jump around between polls.
function syncPens(birds) {
  const counts = {};
  for (const b of birds) {
    if (b.kind === "chick") continue;
    const key = b.project_name || "";
    if (key) counts[key] = (counts[key] || 0) + 1;
  }
  const keys = Object.keys(counts).sort();
  const sig = keys.length >= 2 ? keys.join("\n") : "";
  if (sig === (penState ? penState.sig : "")) return;
  if (penGroup && scene) {
    scene.remove(penGroup);
    disposeObject(penGroup);
  }
  penGroup = null;
  penState = null;
  if (sig) {
    const layout = penLayout(
      keys.map((k) => ({ key: k, count: counts[k] })),
      PEN_FIELD,
    );
    const byKey = {};
    for (const pen of layout.pens) byKey[pen.key] = pen;
    penState = { sig, layout, byKey };
    if (scene) buildPenFences(layout);
  }
  // Wanderers re-pick inside their (possibly new) pen; birds bound
  // elsewhere (nest, home, fence) finish their trip.
  for (const id of Object.keys(flock)) {
    const c = flock[id];
    if (c.mode === "wander" || (c.mode === "walk" && c.afterWalk === "wander"))
      c.routeTo(c.randomFieldPoint(), "wander");
  }
}

// One straw nest (with eggs) per testing chicken, created on demand.
let nestSeed = 4242;
function buildNest() {
  const T = ensureTextures();
  const rnd = mulberry32(nestSeed++);
  const g = new Group();
  const strawMat = lambertMap(T.straw);
  const ring = new Mesh(new TorusGeometry(0.5, 0.18, 8, 18), strawMat);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.14;
  ring.castShadow = true;
  ring.receiveShadow = true;
  g.add(ring);
  const bed = new Mesh(new CylinderGeometry(0.48, 0.4, 0.1, 16), strawMat);
  bed.position.y = 0.07;
  bed.receiveShadow = true;
  g.add(bed);
  const strandG = new CylinderGeometry(0.012, 0.012, 0.5, 4);
  const strandM = lambert(0xd9b36c);
  for (let i = 0; i < 10; i++) {
    const s = new Mesh(strandG, strandM);
    const a = rnd() * Math.PI * 2;
    s.position.set(Math.cos(a) * 0.5, 0.16, Math.sin(a) * 0.5);
    s.rotation.set(
      Math.PI / 2 + (rnd() - 0.5) * 0.5,
      0,
      a + Math.PI / 2 + (rnd() - 0.5) * 0.8,
    );
    g.add(s);
  }
  const egg1 = new Mesh(new SphereGeometry(0.16, 12, 10), lambert(0xfdf6e3));
  egg1.scale.y = 1.3;
  egg1.position.set(0.09, 0.2, 0.04);
  egg1.rotation.z = 0.2;
  egg1.castShadow = true;
  g.add(egg1);
  const egg2 = new Mesh(new SphereGeometry(0.13, 12, 10), lambert(0xf3e4c2));
  egg2.scale.y = 1.28;
  egg2.position.set(-0.14, 0.18, -0.08);
  egg2.rotation.z = -0.3;
  egg2.castShadow = true;
  g.add(egg2);
  return g;
}

// ── Eggs & daily stats board ──────────────────────────────────────────
//
// Done cards leave eggs by the nests (a loose dozen, then a pile) and the
// day's tallies go up on a painted wooden board beside the coop.

let eggGroup = null;
let eggCount = -1;

function syncEggs(count) {
  if (!scene || count === eggCount) return;
  const fresh = eggCount >= 0 && count > eggCount;
  eggCount = count;
  if (eggGroup) {
    scene.remove(eggGroup);
    disposeObject(eggGroup);
    eggGroup = null;
  }
  if (count > 0) {
    eggGroup = new Group();
    const rnd = mulberry32(9871231);
    const shellM = [lambert(0xfdf6e3), lambert(0xf3e4c2), lambert(0xf7ead0)];
    const egg = (x, y, z, i) => {
      const e = new Mesh(
        new SphereGeometry(0.13 + (i % 3) * 0.012, 12, 10),
        shellM[i % 3],
      );
      e.scale.y = 1.3;
      e.position.set(x, y, z);
      e.rotation.set((rnd() - 0.5) * 0.5, rnd() * Math.PI, (rnd() - 0.5) * 0.5);
      e.castShadow = true;
      eggGroup.add(e);
    };
    for (let i = 0; i < Math.min(count, MAX_LOOSE_EGGS); i++) {
      const a = rnd() * Math.PI * 2;
      const r = 0.35 + rnd() * 1.25;
      egg(Math.cos(a) * r, 0.13, Math.sin(a) * r * 0.75, i);
    }
    if (count > MAX_LOOSE_EGGS) {
      // Overflow: a tidy little pile standing in for the extras.
      const pile = [
        [0, 0],
        [0.24, 0.05],
        [-0.22, 0.1],
        [0.04, -0.22],
        [-0.1, 0.28],
      ];
      for (let i = 0; i < pile.length; i++)
        egg(2.0 + pile[i][0], 0.13, -0.5 + pile[i][1], i);
      egg(2.01, 0.36, -0.42, 1);
      egg(1.95, 0.36, -0.55, 2);
    }
    eggGroup.position.copy(EGG_PATCH);
    scene.add(eggGroup);
  }
  if (fresh) spawnPuff(EGG_PATCH.clone()); // a new egg just landed
}

// The daily stats board: a wooden sign beside the coop — painted egg and
// hammer tallies, repainted only when the numbers change.
let statsCanvas = null;
let statsTex = null;
let statsShown = null;

function paintStatsBoard(eggs, tools) {
  const ctx = statsCanvas.getContext("2d");
  const rnd = mulberry32(661991);
  drawWood(ctx, statsCanvas.width, statsCanvas.height, 0x8f6b4a, 4, false, rnd);
  ctx.fillStyle = "#f6efdf";
  // Egg tally: a painted egg and today's count.
  ctx.save();
  ctx.translate(64, 46);
  ctx.scale(1, 1.28);
  ctx.beginPath();
  ctx.arc(0, 0, 20, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.font = "700 52px Georgia, serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(String(eggs), 104, 50);
  // Tool-call tally: a painted hammer and the count.
  ctx.save();
  ctx.translate(62, 118);
  ctx.rotate(-0.5);
  ctx.fillRect(-5, -8, 10, 40); // handle
  ctx.fillRect(-20, -22, 40, 16); // head
  ctx.restore();
  ctx.fillText(String(tools), 104, 118);
}

function updateStatsBoard(eggs, tools) {
  if (!statsCanvas) return;
  const key = eggs + "/" + tools;
  if (key === statsShown) return;
  statsShown = key;
  paintStatsBoard(eggs, tools);
  statsTex.needsUpdate = true;
}

function buildStatsBoard(T) {
  statsCanvas = document.createElement("canvas");
  statsCanvas.width = 256;
  statsCanvas.height = 160;
  paintStatsBoard(0, 0);
  statsShown = "0/0";
  statsTex = new CanvasTexture(statsCanvas);
  statsTex.colorSpace = SRGBColorSpace;

  const g = new Group();
  const postMat = lambertMap(T.post);
  for (const side of [-1, 1]) {
    const post = new Mesh(new CylinderGeometry(0.06, 0.075, 1.5, 7), postMat);
    post.position.set(side * 0.78, 0.75, -0.08);
    post.castShadow = true;
    g.add(post);
  }
  const plankMat = lambertMap(T.floor);
  const board = new Mesh(new BoxGeometry(1.9, 1.15, 0.08), [
    plankMat,
    plankMat,
    plankMat,
    plankMat,
    lambertMap(statsTex),
    plankMat,
  ]);
  board.position.y = 1.35;
  board.castShadow = true;
  board.receiveShadow = true;
  g.add(board);
  const cap = boxMap(2.05, 0.09, 0.14, plankMat);
  cap.position.y = 1.97;
  g.add(cap);
  g.position.set(-6.3, 0, 2.7);
  g.rotation.y = 0.22;
  scene.add(g);
}

/// Roster-level stats from the state payload → eggs on the ground + board.
function syncStats(stats) {
  if (!stats) return;
  window.__coopStats = stats;
  syncEggs(stats.eggs || 0);
  updateStatsBoard(stats.eggs || 0, stats.tool_calls || 0);
}

// ── Chicken model ─────────────────────────────────────────────────────
//
// Rounded birds out of ellipsoids with feather textures, parameterized by
// breed (session kind). The returned handles and pivot semantics are the
// animation contract used by Chicken.update(): neckG.rotation.x dips the
// head to peck, wing rotation.z lifts the wings, legs swing rotation.x at
// the hip, legs hide when nesting. Every breed returns the same handles.

const FEATHER_CACHE = new Map();
function featherMats(plumage, variant) {
  const key = plumage + "|" + (variant || "plain");
  let mats = FEATHER_CACHE.get(key);
  if (!mats) {
    const rnd = mulberry32(plumage ^ (variant === "barred" ? 0x9e37 : 0));
    const tex = makeTexture(
      96,
      96,
      (c, w, h) => drawFeathers(c, w, h, plumage, rnd, variant),
      2,
      2,
    );
    mats = {
      base: lambertMap(tex),
      light: lambert(shadeHex(plumage, 30)),
      dark: lambert(shadeHex(plumage, -42)),
    };
    FEATHER_CACHE.set(key, mats);
  }
  return mats;
}

function buildBirdMesh(seedRnd, kind, chickKind) {
  const isChick = kind === "chick";
  const styleKind = isChick ? chickKind || "hen" : kind || "hen";
  const style = BREED_STYLE[styleKind] || BREED_STYLE.hen;
  let plumage = style.palettes[Math.floor(seedRnd() * style.palettes.length)];
  if (isChick) plumage = chickTint(plumage);
  // Chick down is fluffy, not barred — the tinted palette carries the lineage.
  const M = featherMats(plumage, isChick ? "plain" : style.variant);
  const legMat = lambert(0xe8a33d);
  const combMat = lambert(0xd8402a);
  const root = new Group();

  const orb = (r, mat, sx, sy, sz) => {
    const m = new Mesh(new SphereGeometry(r, 18, 14), mat);
    m.scale.set(sx, sy, sz);
    m.castShadow = true;
    return m;
  };

  const bodyG = new Group();
  bodyG.position.y = isChick ? 0.5 : 0.58;
  root.add(bodyG);

  const body = orb(
    0.42,
    M.base,
    0.82,
    isChick ? 0.86 : 0.8,
    isChick ? 1.0 : 1.16,
  );
  body.rotation.x = 0.1;
  bodyG.add(body);
  const chest = orb(0.3, M.light, 0.72, 0.85, 0.66);
  chest.position.set(0, -0.04, 0.3);
  bodyG.add(chest);
  const rump = orb(0.3, M.base, 0.8, 0.72, 0.72);
  rump.position.set(0, 0.14, -0.3);
  bodyG.add(rump);

  if (isChick) {
    // Tail: a single down puff.
    const puff = orb(0.16, M.light, 1, 0.9, 0.8);
    puff.position.set(0, 0.16, -0.42);
    bodyG.add(puff);
  } else if (kind === "rooster") {
    // Tail: green-black sickles fanned FRONT-TO-BACK from a common quill
    // point — in side profile a serrated arc from upright to trailing.
    const sickle = lambert(0x2c5643);
    const sickleDark = lambert(0x1e3d2f);
    const tailG = new Group();
    tailG.position.set(0, 0.28, -0.44);
    bodyG.add(tailG);
    const rTilts = [-0.3, -0.55, -0.85, -1.15];
    for (let i = 0; i < rTilts.length; i++) {
      const t = rTilts[i];
      const f = orb(0.3, i % 2 ? sickleDark : sickle, 0.13, 1.45, 0.32);
      f.position.set(
        ((i % 2) - 0.5) * 0.1,
        0.3 * Math.cos(t),
        0.3 * Math.sin(t),
      );
      f.rotation.x = t;
      f.rotation.z = ((i % 2) - 0.5) * 0.16;
      tailG.add(f);
    }
    // Two long sickles: the tallest arc and a trailing one.
    for (const side of [-1, 1]) {
      for (const [tilt, len] of [
        [-0.6, 1.85],
        [-1.0, 1.6],
      ]) {
        const s = orb(0.3, sickleDark, 0.1, len, 0.28);
        s.position.set(
          side * 0.06,
          0.34 * Math.cos(tilt),
          0.34 * Math.sin(tilt),
        );
        s.rotation.x = tilt;
        s.rotation.z = side * 0.1;
        tailG.add(s);
      }
    }
  } else {
    // Tail: five feathers fanned FRONT-TO-BACK from a common quill point —
    // in side profile the classic serrated hen wedge, tips up-and-back.
    const tailG = new Group();
    tailG.position.set(0, 0.26, -0.44);
    bodyG.add(tailG);
    const hTilts = [-0.2, -0.45, -0.7, -0.95, -1.2];
    for (let i = 0; i < hTilts.length; i++) {
      const t = hTilts[i];
      const f = orb(0.3, i >= 3 ? M.dark : M.base, 0.15, 1.0, 0.3);
      f.position.set(
        ((i % 2) - 0.5) * 0.07,
        0.24 * Math.cos(t),
        0.24 * Math.sin(t),
      );
      f.rotation.x = t;
      f.rotation.z = ((i % 2) - 0.5) * 0.12;
      tailG.add(f);
    }
  }

  // Wings pivot at their top edge so rotation.z lifts them outward.
  function wing(side) {
    const g = new Group();
    g.position.set(side * 0.3, 0.2, 0.02);
    const w = orb(0.3, M.base, 0.3, 0.72, 1.05);
    w.position.set(side * 0.05, -0.16, -0.04);
    g.add(w);
    for (let i = 0; i < 3; i++) {
      const tip = orb(0.12, M.dark, 0.35, 0.55, 1);
      tip.position.set(side * 0.07, -0.3 + i * 0.015, -0.3 - i * 0.1);
      tip.rotation.x = -0.25 - i * 0.12;
      g.add(tip);
    }
    if (isChick) g.scale.setScalar(0.62); // stubby down wings
    bodyG.add(g);
    return g;
  }
  const wingL = wing(1);
  const wingR = wing(-1);

  // Neck pivot: pecking rotates this. Chicks scale the whole head group up
  // (baby proportions); roosters get a light hackle collar.
  const neckG = new Group();
  neckG.position.set(0, 0.3, 0.34);
  if (isChick) {
    neckG.scale.setScalar(1.28);
    neckG.position.y = 0.24;
  }
  bodyG.add(neckG);

  const neck = new Mesh(
    new CylinderGeometry(0.085, 0.125, isChick ? 0.22 : 0.34, 12),
    M.base,
  );
  neck.rotation.x = 0.22;
  neck.position.set(0, isChick ? 0.04 : 0.1, 0.03);
  neck.castShadow = true;
  neckG.add(neck);
  const head = orb(0.165, M.base, 1, 1.02, 1.05);
  head.position.set(0, isChick ? 0.22 : 0.3, 0.09);
  neckG.add(head);
  if (isChick) {
    // Down tuft on the crown.
    const tuft = orb(0.06, M.light, 1, 0.8, 1);
    tuft.position.set(0, 0.38, 0.06);
    neckG.add(tuft);
  }
  if (kind === "rooster") {
    const hackle = orb(0.24, M.light, 0.95, 0.62, 0.95);
    hackle.position.set(0, 0.03, 0.03);
    neckG.add(hackle);
  }

  // Comb: red lobes along the crown, scaled per breed. Chicks skip it —
  // except rooster chicks, which get a proud little nub.
  const headY = isChick ? 0.22 : 0.3;
  const combK = isChick
    ? chickKind === "rooster"
      ? 0.4
      : 0
    : { hen: 1, rooster: 1.55, barred: 0.85, bantam: 0.6 }[styleKind] || 1;
  if (combK > 0) {
    const lobeCount = styleKind === "rooster" && !isChick ? 5 : 4;
    const combSizes = [0.045, 0.062, 0.058, 0.042, 0.05];
    const combLift = [0, 0.02, 0.015, -0.01, 0.005];
    for (let i = 0; i < lobeCount; i++) {
      const lobe = orb(combSizes[i] * combK, combMat, 0.55, 1.25, 0.9);
      lobe.position.set(
        0,
        headY + 0.155 + combLift[i] * combK,
        0.2 - i * (lobeCount === 5 ? 0.068 : 0.075),
      );
      neckG.add(lobe);
    }
  }

  const beakU = new Mesh(new ConeGeometry(0.055, 0.17, 4), legMat);
  beakU.rotation.x = Math.PI / 2;
  beakU.position.set(0, headY, 0.335);
  beakU.castShadow = true;
  neckG.add(beakU);
  const beakL = new Mesh(new ConeGeometry(0.038, 0.1, 4), lambert(0xd08b2e));
  beakL.rotation.x = Math.PI / 2;
  beakL.position.set(0, headY - 0.035, 0.3);
  neckG.add(beakL);

  // Wattles under the beak (not on chicks), eyes with a cream ring.
  const wattleK = isChick
    ? 0
    : { hen: 1, rooster: 1.6, barred: 1, bantam: 0.7 }[styleKind] || 1;
  for (const side of [-1, 1]) {
    if (wattleK > 0) {
      const wattle = orb(0.042 * wattleK, combMat, 0.7, 1.5, 0.75);
      wattle.position.set(side * 0.045, headY - 0.115, 0.245);
      neckG.add(wattle);
    }
    const ring = orb(0.04, lambert(0xf6efdf), 1, 1, 0.6);
    ring.position.set(side * 0.135, headY + 0.045, 0.175);
    ring.rotation.y = side * 0.55;
    neckG.add(ring);
    const pupil = orb(0.022, lambert(0x1c1c1c), 1, 1, 0.7);
    pupil.position.set(side * 0.15, headY + 0.045, 0.19);
    pupil.rotation.y = side * 0.55;
    neckG.add(pupil);
  }

  // Legs pivot at the hip; thigh fluff, shin, three toes and a rear spur.
  // Chick legs are shorter with a lower hip so the sole stays on the ground.
  const hipY = isChick ? 0.34 : 0.44;
  const legScale = isChick ? 0.78 : 1;
  function leg(side) {
    const g = new Group();
    g.position.set(side * 0.15, hipY, -0.04);
    const thigh = orb(0.1, M.base, 0.95, 1.15, 0.95);
    thigh.position.set(0, -0.05, 0.01);
    g.add(thigh);
    const shin = new Mesh(new CylinderGeometry(0.026, 0.03, 0.3, 8), legMat);
    shin.position.y = -0.27;
    shin.castShadow = true;
    g.add(shin);
    const toe = (ang, len) => {
      const t = new Mesh(new BoxGeometry(0.03, 0.032, len), legMat);
      t.position.set(
        Math.sin(ang) * (len / 2),
        -0.425,
        Math.cos(ang) * (len / 2) + 0.02,
      );
      t.rotation.y = ang;
      t.castShadow = true;
      g.add(t);
    };
    toe(-0.45, 0.17);
    toe(0, 0.19);
    toe(0.45, 0.17);
    const spur = new Mesh(new BoxGeometry(0.028, 0.03, 0.09), legMat);
    spur.position.set(0, -0.425, -0.055);
    g.add(spur);
    g.scale.setScalar(legScale);
    root.add(g);
    return g;
  }
  const legL = leg(1);
  const legR = leg(-1);

  const s = isChick
    ? 0.42 * (0.95 + seedRnd() * 0.15)
    : style.scale[0] + seedRnd() * (style.scale[1] - style.scale[0]);
  root.scale.setScalar(s);

  return { root, bodyG, neckG, wingL, wingR, legL, legR };
}

function buildLabel(title, subtitle) {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 168;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "rgba(255,255,255,0.88)";
  try {
    ctx.beginPath();
    ctx.roundRect(6, 6, 500, 156, 26);
    ctx.fill();
  } catch (e) {
    ctx.fillRect(6, 6, 500, 156);
  }
  ctx.fillStyle = "#2f2a26";
  ctx.font = "600 46px system-ui, sans-serif";
  ctx.textAlign = "center";
  const t = title.length > 20 ? title.slice(0, 19) + "…" : title;
  ctx.fillText(t, 256, 72);
  ctx.fillStyle = "#7a7168";
  ctx.font = "38px system-ui, sans-serif";
  const st = subtitle.length > 24 ? subtitle.slice(0, 23) + "…" : subtitle;
  ctx.fillText(st, 256, 128);
  const tex = new CanvasTexture(canvas);
  const sprite = new Sprite(
    new SpriteMaterial({
      map: tex,
      transparent: true,
      opacity: 0,
      depthTest: false,
    }),
  );
  sprite.scale.set(2.3, 0.75, 1);
  sprite.position.y = 2.05;
  sprite.renderOrder = 9;
  sprite.visible = false; // hover fades it in (see Chicken.update)
  return sprite;
}

// Amber "!" badge floating above a hen with a pending question. Rendered
// with depthTest off so it reads through fences and the coop roof.
function buildAlertIcon() {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  ctx.beginPath();
  ctx.arc(64, 64, 52, 0, Math.PI * 2);
  ctx.fillStyle = "#f5a623";
  ctx.fill();
  ctx.lineWidth = 9;
  ctx.strokeStyle = "#ffffff";
  ctx.stroke();
  ctx.fillStyle = "#3a2a08";
  ctx.font = "800 82px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("!", 64, 70);
  const tex = new CanvasTexture(canvas);
  const sprite = new Sprite(
    new SpriteMaterial({ map: tex, transparent: true, depthTest: false }),
  );
  sprite.scale.set(0.55, 0.55, 1);
  sprite.position.y = 2.55;
  sprite.renderOrder = 10;
  sprite.visible = false;
  return sprite;
}
// A little wooden stop stake planted beside a blocked hen: post plus a
// painted red octagon with a cream bar — no text, the paint carries it.
function buildBlockedStake() {
  const T = ensureTextures();
  const g = new Group();
  const post = new Mesh(
    new CylinderGeometry(0.045, 0.06, 0.95, 7),
    lambertMap(T.post),
  );
  post.position.y = 0.47;
  post.castShadow = true;
  g.add(post);
  const disc = new Mesh(
    new CylinderGeometry(0.21, 0.21, 0.05, 8),
    lambert(0xb0402c),
  );
  disc.rotation.x = Math.PI / 2;
  disc.position.y = 1.0;
  disc.castShadow = true;
  g.add(disc);
  for (const side of [-1, 1]) {
    const bar = new Mesh(
      new BoxGeometry(0.24, 0.065, 0.012),
      lambert(0xf6efdf),
    );
    bar.position.set(0, 1.0, side * 0.032);
    g.add(bar);
  }
  return g;
}

function disposeObject(obj) {
  obj.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (m.map) m.map.dispose();
        m.dispose();
      }
    }
  });
}

// Short-lived dust puff for vigorous pecks.
const puffs = [];
function spawnPuff(pos) {
  if (!scene) return;
  const g = new Group();
  for (let i = 0; i < 4; i++) {
    const p = new Mesh(new SphereGeometry(0.055, 5, 4), lambert(0xcdb98e));
    p.position.set(
      (Math.random() - 0.5) * 0.3,
      0.05,
      (Math.random() - 0.5) * 0.3,
    );
    p.userData.vel = new Vector3(
      (Math.random() - 0.5) * 1.2,
      0.9 + Math.random(),
      (Math.random() - 0.5) * 1.2,
    );
    g.add(p);
  }
  g.position.copy(pos);
  scene.add(g);
  puffs.push({ g, t: 0 });
}

function updatePuffs(dt) {
  for (let i = puffs.length - 1; i >= 0; i--) {
    const puff = puffs[i];
    puff.t += dt;
    for (const p of puff.g.children) {
      p.position.addScaledVector(p.userData.vel, dt);
      p.userData.vel.y -= 3.2 * dt;
      p.scale.multiplyScalar(1 - 2.2 * dt);
    }
    if (puff.t > 0.55) {
      scene.remove(puff.g);
      disposeObject(puff.g);
      puffs.splice(i, 1);
    }
  }
}

// ── Feed scatter ──────────────────────────────────────────────────────
//
// Clicking empty ground (no bird under the ray) tosses a handful of feed
// kernels there: a short arc of grain, a dust puff on landing, and nearby
// idle birds trot over to peck it up. Working birds mid-task, nesting /
// roosting / sulking birds, and birds fenced into another pen all ignore
// it — the job comes first. A short cooldown keeps it from being spammed.

const feedPiles = [];
let lastFeedAt = -Infinity;

// ?feed=<x>,<z> (demo/tests): auto-toss feed at that field spot shortly
// after load and every ~12s after, so the frenzy can be screenshotted
// headlessly (a real pointer click isn't reachable from the harness).
const FEED_PARAM = (() => {
  try {
    const v = new URLSearchParams(location.search).get("feed");
    if (!v) return null;
    const [x, z] = v.split(",").map(parseFloat);
    return Number.isFinite(x) && Number.isFinite(z) ? { x, z } : null;
  } catch (e) {
    return null;
  }
})();
let feedClock = 0;
let nextParamFeedAt = FEED_PARAM ? 2 : Infinity;

const KERNEL_COLORS = [0xd9a441, 0xc98f2e, 0xe8c25a];

function penAt(p) {
  if (!penState) return null;
  for (const pen of penState.layout.pens) {
    if (rectContains(pen.rect, p)) return pen;
  }
  return null;
}

/// Birds only cross to feed inside their own territory: same pen, or
/// both bird and feed out on the commons.
function feedReachable(c, pos) {
  if (!penState) return true;
  return birdPen(c) === penAt({ x: pos.x, z: pos.z });
}

function eatKernel(pile) {
  const k = pile.live.pop();
  if (!k) return;
  pile.g.remove(k.m);
  disposeObject(k.m);
}

function recruitForFeed(pile) {
  for (const id of Object.keys(flock)) {
    const c = flock[id];
    if (c.kind === "chick") continue; // chicks tag along with their parent
    const idle =
      c.mode === "wander" || (c.mode === "walk" && c.afterWalk === "wander");
    if (!idle || c.peckQueue.length) continue;
    if (c.posV.distanceTo(pile.pos) > FEED_RADIUS) continue;
    if (!feedReachable(c, pile.pos)) continue;
    const a = Math.random() * Math.PI * 2;
    const r = 0.45 + Math.random() * 0.3;
    c.feedPile = pile;
    c.routeTo(
      new Vector3(
        pile.pos.x + Math.sin(a) * r,
        0,
        pile.pos.z + Math.cos(a) * r,
      ),
      "feed",
    );
  }
}

function scatterFeed(pos) {
  if (!scene) return null;
  const g = new Group();
  const pile = { g, pos: pos.clone(), live: [], falling: [], t: 0 };
  for (let i = 0; i < FEED_KERNELS; i++) {
    const m = new Mesh(
      new SphereGeometry(0.045, 5, 4),
      lambert(KERNEL_COLORS[i % KERNEL_COLORS.length]),
    );
    m.scale.y = 0.65;
    m.position.set(pos.x, 0.85, pos.z);
    const a = Math.random() * Math.PI * 2;
    const sp = 0.5 + Math.random() * 0.9;
    pile.falling.push({
      m,
      vel: new Vector3(
        Math.sin(a) * sp,
        0.6 + Math.random() * 0.9,
        Math.cos(a) * sp,
      ),
    });
    g.add(m);
  }
  scene.add(g);
  feedPiles.push(pile);
  return pile;
}

/// Ground-click entry point: cooldown-gated toss. Recruitment happens
/// when the first kernel lands (updateFeed).
function tryScatterFeed(pos, force) {
  const now = performance.now() / 1000;
  if (!force && now - lastFeedAt < FEED_COOLDOWN_S) return false;
  lastFeedAt = now;
  return !!scatterFeed(pos);
}

function updateFeed(dt) {
  feedClock += dt;
  if (feedClock >= nextParamFeedAt) {
    nextParamFeedAt = feedClock + 12;
    tryScatterFeed(new Vector3(FEED_PARAM.x, 0, FEED_PARAM.z), true);
  }
  for (let i = feedPiles.length - 1; i >= 0; i--) {
    const pile = feedPiles[i];
    pile.t += dt;
    for (let j = pile.falling.length - 1; j >= 0; j--) {
      const k = pile.falling[j];
      k.m.position.addScaledVector(k.vel, dt);
      k.vel.y -= 6.5 * dt;
      if (k.vel.y < 0 && k.m.position.y <= 0.03) {
        k.m.position.y = 0.03;
        pile.falling.splice(j, 1);
        pile.live.push(k);
        if (!pile.landed) {
          pile.landed = true;
          spawnPuff(pile.pos);
          recruitForFeed(pile);
        }
      }
    }
    // Uneaten leftovers shrink away after a while; eaten-out piles clean
    // up immediately.
    const expired = pile.t > FEED_EXPIRE_S;
    if (expired) {
      for (const k of pile.live) k.m.scale.multiplyScalar(1 - 1.5 * dt);
    }
    if (
      (!pile.live.length && !pile.falling.length) ||
      pile.t > FEED_EXPIRE_S + 1
    ) {
      scene.remove(pile.g);
      disposeObject(pile.g);
      feedPiles.splice(i, 1);
      for (const id of Object.keys(flock)) {
        if (flock[id].feedPile === pile) flock[id].feedPile = null;
      }
    }
  }
}

// ── Chicken controller ────────────────────────────────────────────────

let nestSlots = 0;
/// Roster id of the bird under the pointer (name-tag fade target).
let hoverId = null;

class Chicken {
  constructor(info) {
    this.cardId = info.id || info.card_id; // roster id (card id for hens)
    this.kind = info.kind || "hen";
    this.chickKind = info.chick_kind || null;
    this.parentId = info.parent_id || null;
    this.chickSlot = 0;
    this.nextChickSlot = 0;
    this.title = info.title;
    this.project = info.project_name || "";
    this.phase = info.phase;
    this.activitySeen = info.activity;
    this.lastTool = info.last_tool || null;
    this.busy = !!info.busy;
    this.blocked = false;
    this.stake = null;
    this.fencePos = null;
    this.roostPos = null;
    this.lastActivityTs = info.last_activity_ts || null;
    this.labelOp = 0;
    this.pecksPlayed = 0;
    this.peckQueue = [];
    this.mode = "emerge";
    this.removed = false;
    this.question = null;
    this.answeredQid = null;
    this.celebrateT = 0;
    this.feedPile = null;
    this.feedDips = 0;

    this.posV = DOOR_POS.clone();
    this.yaw = 0;
    this.target = null;
    this.route = []; // queued waypoints (gate/corridor legs) after target
    this.afterWalk = "wander";
    this.pauseUntil = 0;
    this.peckT = 0;
    this.peckPlan = null;
    this.flapAt = 2 + Math.random() * 4;
    this.clock = 0;
    this.walkPhase = 0;
    this.nest = null;
    this.nestPos = null;
    this.fadeT = -1;
    this.alertBaseY = this.kind === "chick" ? 3.4 : 2.55;

    // Chicks hatch next to their parent and take a follow slot.
    const parent =
      this.kind === "chick" && this.parentId ? flock[this.parentId] : null;
    if (parent) {
      this.chickSlot = parent.nextChickSlot++;
      this.posV = parent.posV
        .clone()
        .add(new Vector3(0.4 + 0.2 * (this.chickSlot % 3), 0, -0.5));
    }

    const rnd = mulberry32(hashStr(this.cardId));
    if (scene) {
      this.viz = buildBirdMesh(rnd, this.kind, this.chickKind);
      this.viz.root.position.copy(this.posV);
      this.viz.root.userData.cardId = this.cardId;
      this.label = buildLabel(
        this.title,
        this.project || KIND_LABEL[this.kind] || "",
      );
      if (this.kind === "chick") {
        // The root is ~0.42-scaled, which shrinks children too: boost the
        // label/alert back to readable size and hover height.
        this.label.scale.multiplyScalar(1.45);
        this.label.position.y = 4.6;
      }
      this.viz.root.add(this.label);
      this.alert = buildAlertIcon();
      this.alert.position.y = this.alertBaseY;
      this.viz.root.add(this.alert);
      scene.add(this.viz.root);
      this.baseScale = this.viz.root.scale.x;
    } else {
      this.viz = null;
      this.alert = null;
      this.baseScale = 1;
    }
    this.setQuestion(info.question || null);

    if (parent) {
      this.mode = "follow"; // steering picks a slot target next frame
    } else {
      this.routeTo(this.randomFieldPoint(rnd), "wander");
    }
    if (info.phase === "testing") this.goNest();
    if (info.phase === "done" || info.phase === "wont_do") this.goHome();
    if (info.blocked) this.setBlocked(true);
  }

  // question: {id, session_id, data} | null — drives the alert icon. A
  // question the user just answered locally stays suppressed even while the
  // roster still reports it (the resolution lands async host-side).
  setQuestion(q) {
    if (q && this.answeredQid === q.id) q = null;
    // A badge newly appearing (not just re-reported) gets the rooster crow.
    if (q && !(this.question && this.question.id === q.id)) sound.crow();
    this.question = q || null;
    if (this.alert) this.alert.visible = !!this.question;
  }

  // Blocked cards: the hen trudges to the fence, faces out through the
  // rails, and mopes by a stop stake until the card unblocks. Only field
  // hens sulk — a nesting (testing) hen stays on her nest.
  setBlocked(b) {
    b = !!b;
    if (b === this.blocked) return;
    this.blocked = b;
    if (b) {
      if (this.phase !== "working") return;
      const rnd = mulberry32(hashStr(this.cardId) ^ 0x5bf035);
      const pen = birdPen(this);
      this.fencePos = pen
        ? new Vector3(
            pen.rect.maxX - 0.45,
            0,
            pen.rect.minZ + 0.9 + rnd() * (pen.rect.maxZ - pen.rect.minZ - 1.8),
          )
        : new Vector3(FENCE_X, 0, -3.4 + rnd() * 8.4);
      if (scene && !this.stake) {
        this.stake = buildBlockedStake();
        this.stake.position.set(
          this.fencePos.x - 0.15,
          0,
          this.fencePos.z - 0.8,
        );
        this.stake.rotation.y = -0.5;
        scene.add(this.stake);
      }
      this.peckQueue.length = 0;
      this.peckPlan = null;
      this.routeTo(this.fencePos, "sulk");
    } else {
      this.removeStake();
      if (this.mode === "sulk" || this.afterWalk === "sulk") {
        this.routeTo(this.randomFieldPoint(), "wander");
      }
    }
  }

  removeStake() {
    if (this.stake && scene) {
      scene.remove(this.stake);
      disposeObject(this.stake);
    }
    this.stake = null;
    if (this.viz) this.viz.bodyG.rotation.x = 0; // undo the sulk hunch
  }

  randomFieldPoint(rnd) {
    const r = rnd || Math;
    const rx = r.random ? r.random() : r();
    const rz = r.random ? r.random() : r();
    const rect = wanderRect(this);
    const inset = penState ? 0.55 : 0;
    return new Vector3(
      rect.minX + inset + rx * (rect.maxX - rect.minX - 2 * inset),
      0,
      rect.minZ + inset + rz * (rect.maxZ - rect.minZ - 2 * inset),
    );
  }

  walkTo(v, afterMode) {
    if (this.mode === "roost") this.standUp(); // legs back for the walk
    if (afterMode !== "feed") this.feedPile = null;
    this.route.length = 0;
    this.target = v.clone();
    this.afterWalk = afterMode;
    if (this.mode !== "emerge") this.mode = "walk";
  }

  // Fence-aware walk: route through pen gates and along the commons
  // corridor when pens are up; plain walkTo otherwise.
  routeTo(v, afterMode) {
    if (!penState) return this.walkTo(v, afterMode);
    const pts = penRoute(
      { x: this.posV.x, z: this.posV.z },
      { x: v.x, z: v.z },
      penState.layout,
    );
    this.walkTo(new Vector3(pts[0].x, 0, pts[0].z), afterMode);
    for (let i = 1; i < pts.length; i++)
      this.route.push(new Vector3(pts[i].x, 0, pts[i].z));
  }

  setPhase(phase) {
    if (phase === this.phase) return;
    const prev = this.phase;
    this.phase = phase;
    if (phase === "testing") this.goNest();
    else if (phase === "done" || phase === "wont_do") this.goHome();
    else if (
      phase === "working" &&
      (prev === "testing" || prev === "done" || prev === "wont_do")
    ) {
      this.leaveNest();
      if (this.blocked) {
        this.blocked = false; // replant: re-run the fence walk
        this.setBlocked(true);
      } else {
        this.routeTo(this.randomFieldPoint(), "wander");
      }
    }
  }

  goNest() {
    this.removeStake();
    if (!this.nestPos) {
      const slot = nestSlots++;
      this.nestPos = new Vector3(
        NEST_BASE.x,
        0,
        NEST_BASE.z + (slot % 6) * NEST_GAP,
      );
    }
    if (scene && !this.nest) {
      this.nest = buildNest();
      this.nest.position.copy(this.nestPos);
      scene.add(this.nest);
    }
    this.peckPlan = null;
    this.routeTo(this.nestPos, "nest");
  }

  leaveNest() {
    if (this.nest && scene) {
      scene.remove(this.nest);
      disposeObject(this.nest);
    }
    this.nest = null;
    this.posV.y = 0;
    if (this.viz) {
      this.viz.legL.visible = true;
      this.viz.legR.visible = true;
    }
  }

  goHome() {
    this.leaveNest();
    this.removeStake();
    this.peckQueue.length = 0;
    this.peckPlan = null;
    // A finishing chick delivers its result: run to the parent and vanish
    // there. Orphans (and every other bird) head for the coop door.
    const parent =
      this.kind === "chick" && this.parentId ? flock[this.parentId] : null;
    if (parent && !parent.removed && parent.mode !== "gone") {
      this.walkTo(parent.posV.clone(), "absorb");
      return;
    }
    this.routeTo(DOOR_POS, "homeArrive");
  }

  // Roster no longer contains this card at all: same exit as done.
  setGone() {
    if (this.mode === "homeArrive" || this.mode === "gone") return;
    this.goHome();
  }

  noteActivity(activity, toolClass) {
    if (activity > this.activitySeen) {
      markActive(this);
      const n = pecksToQueue(
        this.activitySeen,
        activity,
        this.peckQueue.length,
        MAX_QUEUED_PECKS,
      );
      for (let i = 0; i < n; i++) this.peckQueue.push(toolClass || "other");
    }
    this.activitySeen = Math.max(this.activitySeen, activity);
  }

  startPeck(cls) {
    this.mode = "peck";
    this.peckT = 0;
    // dips: [count, speed] per tool class; command also puffs dust.
    this.peckPlan =
      cls === "command"
        ? { dips: 3, speed: 7.5, dust: true, tilt: 0 }
        : cls === "edit"
          ? { dips: 2, speed: 5.5, dust: true, tilt: 0 }
          : cls === "read"
            ? { dips: 1, speed: 3.2, dust: false, tilt: 0.5 }
            : { dips: 1, speed: 4.5, dust: false, tilt: 0 };
    sound.cluck(cls);
    markActive(this);
    this.pecksPlayed++;
  }

  update(dt) {
    const viz = this.viz;

    // Chicks shadow their parent: pick a slot behind it (or a spot around
    // its nest) and keep closing on it. Re-steered continuously, so a moving
    // parent drags its brood along.
    if (
      this.kind === "chick" &&
      this.phase === "working" &&
      (this.mode === "wander" || this.mode === "walk" || this.mode === "follow")
    ) {
      const parent = this.parentId ? flock[this.parentId] : null;
      if (parent && !parent.removed && parent.mode !== "gone") {
        let anchor = parent.posV;
        let baseYaw = parent.yaw + Math.PI; // behind the parent
        let ringR = 0.8 + (this.chickSlot % 3) * 0.24;
        if (parent.mode === "nest" && parent.nestPos) {
          anchor = parent.nestPos;
          baseYaw = 0;
          ringR = 1.15;
        }
        const a = baseYaw + ((this.chickSlot % 5) - 2) * 0.55;
        let tx = anchor.x + Math.sin(a) * ringR;
        let tz = anchor.z + Math.cos(a) * ringR;
        // Chicks stay penned with their parent — but only while the
        // parent is actually inside (a nesting parent waits outside).
        const pen = birdPen(this);
        if (pen && rectContains(pen.rect, { x: anchor.x, z: anchor.z })) {
          tx = MathUtils.clamp(tx, pen.rect.minX + 0.3, pen.rect.maxX - 0.3);
          tz = MathUtils.clamp(tz, pen.rect.minZ + 0.3, pen.rect.maxZ - 0.3);
        }
        const dx = tx - this.posV.x;
        const dz = tz - this.posV.z;
        if (dx * dx + dz * dz > 0.12) {
          this.route.length = 0; // steering overrides any queued route
          this.target = new Vector3(tx, 0, tz);
          this.afterWalk = "follow";
          this.mode = "walk";
        }
      }
    }

    // Night: idle birds retire to a spot beside the coop and doze there.
    // Anything with live work — pecks queued, a pending question, a card
    // in flight — stays out and keeps at it.
    const wantsRoost = isNight && this.roostEligible();
    if (
      wantsRoost &&
      (this.mode === "wander" ||
        (this.mode === "walk" && this.afterWalk === "wander"))
    ) {
      if (!this.roostPos) {
        const r = mulberry32(hashStr(this.cardId) ^ 0x520a11);
        this.roostPos = new Vector3(
          DOOR_POS.x - 0.6 + r() * 1.9,
          0,
          DOOR_POS.z - 2.6 + r() * 3.4,
        );
      }
      this.routeTo(this.roostPos, "roost");
    } else if (
      !wantsRoost &&
      (this.mode === "roost" ||
        (this.mode === "walk" && this.afterWalk === "roost"))
    ) {
      this.routeTo(this.randomFieldPoint(), "wander");
    }
    // Movement for walking modes.
    const moving =
      (this.mode === "walk" || this.mode === "emerge") && this.target;
    if (moving) {
      // A chick absorbing into a moving parent keeps retargeting it.
      if (this.afterWalk === "absorb" && this.parentId) {
        const parent = flock[this.parentId];
        if (parent && !parent.removed && parent.mode !== "gone")
          this.target.copy(parent.posV);
      }
      const to = this.target.clone().sub(this.posV);
      to.y = 0;
      const dist = to.length();
      const speed =
        this.afterWalk === "homeArrive"
          ? HOME_SPEED
          : this.afterWalk === "absorb"
            ? HOME_SPEED * 1.15
            : this.afterWalk === "follow" && dist > 2
              ? WALK_SPEED * 1.7
              : WALK_SPEED;
      if (dist < 0.12 && this.route.length) {
        // Waypoint reached: carry on along the fence-aware route.
        this.target = this.route.shift();
      } else if (dist < 0.12) {
        this.mode =
          this.afterWalk === "homeArrive" ? "homeArrive" : this.afterWalk;
        this.target = null;
        this.pauseUntil = performance.now() / 1000 + 1 + Math.random() * 2.2;
        if (this.mode === "nest") this.sitDown();
        if (this.mode === "roost") this.sitDown(-0.1);
        if (this.mode === "feed") {
          this.peckT = 0;
          this.feedDips = 0;
        }
        if (this.mode === "homeArrive" || this.mode === "absorb")
          this.fadeT = 0;
      } else {
        to.normalize();
        this.posV.addScaledVector(to, Math.min(speed * dt, dist));
        const targetYaw = Math.atan2(to.x, to.z);
        let d = targetYaw - this.yaw;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        this.yaw += d * Math.min(1, 8 * dt);
        this.walkPhase += dt * speed * 5.2;
      }
    }

    // Idle: play queued pecks; wanderers also pick fresh waypoints (chicks
    // in follow stand their slot until the parent moves).
    if (this.mode === "wander" || this.mode === "follow") {
      if (this.peckQueue.length > 0) {
        this.startPeck(this.peckQueue.shift());
      } else if (
        this.mode === "wander" &&
        performance.now() / 1000 > this.pauseUntil
      ) {
        this.routeTo(this.randomFieldPoint(), "wander");
      }
    }

    // Feeding: face the pile and peck; each full head dip eats one
    // kernel. Real work interrupts the meal — queued pecks come first —
    // and a sated bird (or an empty pile) drifts back to wandering.
    if (this.mode === "feed") {
      const pile = this.feedPile;
      if (
        !pile ||
        !pile.live.length ||
        this.feedDips >= 4 ||
        this.peckQueue.length
      ) {
        this.feedPile = null;
        this.mode = "wander";
        this.pauseUntil = performance.now() / 1000 + 0.6 + Math.random();
        if (viz) viz.neckG.rotation.x = 0;
      } else {
        let d =
          Math.atan2(pile.pos.x - this.posV.x, pile.pos.z - this.posV.z) -
          this.yaw;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        this.yaw += d * Math.min(1, 6 * dt);
        const prevDip = Math.floor(this.peckT / Math.PI);
        this.peckT += dt * 5.2;
        if (Math.floor(this.peckT / Math.PI) > prevDip) {
          eatKernel(pile);
          this.feedDips++;
        }
        if (viz) {
          viz.neckG.rotation.x = Math.abs(Math.sin(this.peckT)) * 1.15;
          viz.legL.rotation.x = 0;
          viz.legR.rotation.x = 0;
          viz.root.position.y = 0;
        }
      }
    }

    // Peck animation: rapid neck dips, optional head tilt / dust.
    if (this.mode === "peck" && this.peckPlan) {
      this.peckT += dt * this.peckPlan.speed;
      if (this.peckT >= this.peckPlan.dips * Math.PI) {
        this.mode = "wander";
        this.pauseUntil = performance.now() / 1000 + 0.4 + Math.random();
        this.peckPlan = null;
        if (viz) {
          viz.neckG.rotation.x = 0;
          viz.neckG.rotation.z = 0;
        }
      } else if (viz) {
        const dip = Math.abs(Math.sin(this.peckT));
        viz.neckG.rotation.x = dip * 1.15;
        viz.neckG.rotation.z = this.peckPlan.tilt * Math.sin(this.peckT * 0.5);
        if (this.peckPlan.dust && dip > 0.97) {
          spawnPuff(
            this.posV
              .clone()
              .add(
                new Vector3(
                  Math.sin(this.yaw) * 0.6,
                  0,
                  Math.cos(this.yaw) * 0.6,
                ),
              ),
          );
          this.peckPlan.dust = false;
        }
      }
    }

    // Nesting: settled on the egg, occasional wing flap.
    if (this.mode === "nest" && viz) {
      this.flapAt -= dt;
      if (this.flapAt <= 0) this.flapAt = 4 + Math.random() * 3;
      const flap =
        this.flapAt > 0.6 ? 0 : Math.sin((0.6 - this.flapAt) * 18) * 1.1;
      viz.wingL.rotation.z = -Math.abs(flap);
      viz.wingR.rotation.z = Math.abs(flap);
      viz.bodyG.rotation.z = Math.sin(performance.now() / 900) * 0.03;
    }

    // Roosting: tucked down by the coop, head low, the slightest sway.
    if (this.mode === "roost" && viz) {
      viz.neckG.rotation.x = 0.42 + Math.sin(performance.now() / 1300) * 0.04;
      viz.bodyG.rotation.z = Math.sin(performance.now() / 1100) * 0.02;
      viz.wingL.rotation.z = -0.12;
      viz.wingR.rotation.z = 0.12;
    }

    // Blocked: stand at the fence facing out (+x), hunched, head hung,
    // wings slumped. removeStake undoes the hunch when the sulk ends.
    if (this.mode === "sulk" && viz) {
      let d = Math.PI / 2 - this.yaw;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      this.yaw += d * Math.min(1, 4 * dt);
      viz.neckG.rotation.x = 0.6 + Math.sin(performance.now() / 1100) * 0.05;
      viz.bodyG.rotation.x = 0.16;
      viz.wingL.rotation.z = -0.34;
      viz.wingR.rotation.z = 0.34;
      viz.legL.rotation.x = 0;
      viz.legR.rotation.x = 0;
    }
    // Arrived home: shrink into the doorway, then remove.
    if (this.mode === "homeArrive") {
      this.fadeT += dt;
      if (viz) {
        const k = Math.max(0.001, 1 - this.fadeT / 0.45);
        viz.root.scale.setScalar(this.baseScale * k);
      }
      if (this.fadeT > 0.5) {
        this.mode = "gone";
        this.dispose();
      }
    }

    // Apply transform + gait to the mesh.
    if (viz && this.mode !== "gone") {
      viz.root.position.copy(this.posV);
      viz.root.rotation.y = this.yaw;
      if (moving) {
        const sw = Math.sin(this.walkPhase);
        viz.legL.rotation.x = sw * 0.85;
        viz.legR.rotation.x = -sw * 0.85;
        viz.root.position.y = Math.abs(Math.sin(this.walkPhase)) * 0.06;
        viz.neckG.rotation.x = 0.12 + Math.sin(this.walkPhase * 2) * 0.08;
        viz.wingL.rotation.z = -0.12;
        viz.wingR.rotation.z = 0.12;
      } else if (this.mode === "wander" || this.mode === "follow") {
        viz.legL.rotation.x = 0;
        viz.legR.rotation.x = 0;
        viz.root.position.y = 0;
        viz.neckG.rotation.x = Math.sin(performance.now() / 700) * 0.06;
        viz.wingL.rotation.z = 0;
        viz.wingR.rotation.z = 0;
      }
    }

    // A finished chick reached its parent: happy hops, shrink, puff, gone.
    // (After the transform block so the hop's y survives the posV copy.)
    if (this.mode === "absorb") {
      this.fadeT += dt;
      const t = this.fadeT;
      if (viz) {
        viz.root.position.y =
          Math.abs(Math.sin(t * 9)) * 0.3 * Math.max(0, 1 - t / 0.7);
        const k = Math.max(0.001, 1 - t / 0.7);
        viz.root.scale.setScalar(this.baseScale * k);
      }
      if (this.fadeT > 0.75) {
        spawnPuff(this.posV.clone());
        this.mode = "gone";
        this.dispose();
      }
    }

    // Hover name tag: fade toward visible only while this bird is hovered.
    if (this.label) {
      const want = hoverId === this.cardId && this.mode !== "gone" ? 1 : 0;
      this.labelOp += (want - this.labelOp) * Math.min(1, dt * 9);
      if (want === 0 && this.labelOp < 0.02) this.labelOp = 0;
      this.label.material.opacity = this.labelOp;
      this.label.visible = this.labelOp > 0.01;
    }
    // Alert icon: bob + gentle pulse while a question is pending; a short
    // celebratory double-flap right after the user answers.
    if (this.alert && this.alert.visible) {
      const tSec = performance.now() / 1000;
      this.alert.position.y = this.alertBaseY + Math.sin(tSec * 3.1) * 0.09;
      const k = 1 + Math.sin(tSec * 5.3) * 0.05;
      this.alert.scale.set(0.55 * k, 0.55 * k, 1);
    }
    if (this.celebrateT > 0 && viz && this.mode !== "gone") {
      this.celebrateT -= dt;
      const f = Math.sin(this.celebrateT * 24) * 1.1;
      viz.wingL.rotation.z = -Math.abs(f);
      viz.wingR.rotation.z = Math.abs(f);
      if (this.celebrateT <= 0) {
        viz.wingL.rotation.z = 0;
        viz.wingR.rotation.z = 0;
      }
    }
  }

  sitDown(depth = -0.18) {
    if (!this.viz) return;
    this.viz.legL.visible = false;
    this.viz.legR.visible = false;
    this.posV.y = depth; // sunk into the nest/ground; frame loop applies posV
    this.viz.neckG.rotation.x = 0;
  }

  standUp() {
    this.posV.y = 0;
    if (!this.viz) return;
    this.viz.legL.visible = true;
    this.viz.legR.visible = true;
    this.viz.neckG.rotation.x = 0;
  }

  // No live work keeping this bird outside after dark. Chicks are excluded:
  // they just follow their parent.
  roostEligible() {
    return (
      !this.busy &&
      !this.question &&
      !this.blocked &&
      this.kind !== "chick" &&
      (this.phase === "working" || this.phase === "idle") &&
      this.peckQueue.length === 0 &&
      !this.peckPlan
    );
  }

  dispose() {
    this.removed = true;
    this.leaveNest();
    this.removeStake();
    if (this.viz && scene) {
      scene.remove(this.viz.root);
      disposeObject(this.viz.root);
    }
  }
}

// ── Fetch bridge (parent-proxied; the iframe has no direct API access) ──

let reqSeq = 0;
const pending = {};

function apiFetch(path, opts) {
  return new Promise((resolve, reject) => {
    const requestId = ++reqSeq;
    pending[requestId] = { resolve, reject };
    window.parent.postMessage(
      {
        type: "plugin-ui-fetch",
        requestId,
        method: (opts && opts.method) || "GET",
        path,
        body: opts && typeof opts.body === "string" ? opts.body : undefined,
      },
      "*",
    );
    setTimeout(() => {
      if (pending[requestId]) {
        delete pending[requestId];
        reject(new Error("bridge timeout"));
      }
    }, 8000);
  });
}

window.addEventListener("message", (e) => {
  const m = e.data;
  if (!m || m.type !== "plugin-ui-fetch-result" || !pending[m.requestId])
    return;
  const p = pending[m.requestId];
  delete pending[m.requestId];
  p.resolve({ status: m.status, body: m.body });
});

// ── Demo roster (standalone page, no app parent) ──────────────────────

const DEMO = window.parent === window;

function demoState(t) {
  // After dark the two quiet session birds go idle so the demo showcases
  // roosting; the workers keep pecking (active work stays out).
  const demoNight = dayFactor01(localHour()) < 0.3;
  const birds = [
    {
      id: "demo-worker",
      card_id: "demo-worker",
      kind: "hen",
      project_name: "coop-app",
      title: "Implement egg module",
      step: "in_progress",
      phase: "working",
      activity: Math.floor(t / 3),
      tool_class: ["command", "edit", "read", "other"][Math.floor(t / 3) % 4],
      last_tool: "Bash",
      blocked: false,
      busy: true,
      last_activity_ts: Date.now() - 42_000,
      question:
        t > 6
          ? {
              id: "demo-q-1",
              session_id: "demo-session",
              data: {
                questions: [
                  {
                    question:
                      "Which storage should the egg module use for shell records?",
                    header: "Design",
                    options: [
                      {
                        label: "SQLite",
                        description:
                          "Single file, zero setup — fine for one coop",
                      },
                      {
                        label: "PostgreSQL",
                        description: "Heavier, but survives a multi-coop farm",
                      },
                    ],
                    multiSelect: false,
                  },
                ],
                cardTitle: "Implement egg module",
                cardDescription:
                  "Add an `EggStore` used by the layer service.\n\n- `lay(egg)` persists a new egg\n- `hatch(id)` marks it hatched\n\n```ts\ninterface EggStore {\n  lay(egg: Egg): Promise<void>;\n  hatch(id: string): Promise<Chick>;\n}\n```",
                projectName: "coop-app",
              },
            }
          : null,
    },
    {
      id: "demo-tester",
      card_id: "demo-tester",
      kind: "hen",
      project_name: "egg-farm",
      title: "Review coop door",
      step: "review",
      phase: "testing",
      activity: 0,
      tool_class: null,
      last_tool: null,
      blocked: false,
      busy: true,
      last_activity_ts: Date.now() - 340_000,
    },
    {
      id: "demo-blocked",
      card_id: "demo-blocked",
      kind: "hen",
      project_name: "coop-app",
      title: "Waiting on schema card",
      step: "in_progress",
      phase: "working",
      activity: 0,
      tool_class: null,
      last_tool: null,
      blocked: true,
      busy: false,
      last_activity_ts: Date.now() - 600_000,
    },
    {
      id: "demo-mill",
      card_id: "demo-mill",
      kind: "hen",
      project_name: "feed-mill",
      title: "Grind layer pellets",
      step: "in_progress",
      phase: "working",
      activity: Math.floor(t / 4),
      tool_class: "edit",
      last_tool: "edit_file",
      blocked: false,
      busy: true,
      last_activity_ts: Date.now() - 21_000,
    },
    {
      id: "demo-chat",
      kind: "rooster",
      project_name: "",
      title: "Morning planning",
      phase: "working",
      activity: Math.floor(t / 4),
      tool_class: "read",
      last_tool: "search_web",
      blocked: false,
      busy: true,
      last_activity_ts: Date.now() - 8_000,
      question:
        t > 12
          ? {
              id: "demo-q-2",
              session_id: "demo-chat-session",
              data: {
                question:
                  "Deploy the coop update to the farm fleet now, or wait for the weekend window?",
                options: ["Deploy now", "Weekend window"],
              },
            }
          : null,
    },
    {
      id: "demo-cron",
      kind: "barred",
      project_name: "",
      title: "Nightly digest",
      phase: demoNight ? "idle" : "working",
      activity: demoNight ? 0 : Math.floor(t / 5),
      tool_class: "read",
      last_tool: "read_file",
      blocked: false,
      busy: !demoNight,
      last_activity_ts: Date.now() - 1_800_000,
    },
    {
      id: "demo-temp",
      kind: "bantam",
      project_name: "",
      title: "research: egg prices",
      phase: demoNight ? "idle" : "working",
      activity: demoNight ? 0 : Math.floor(t / 6),
      tool_class: "read",
      last_tool: "fetch_url",
      blocked: false,
      busy: !demoNight,
      last_activity_ts: Date.now() - 125_000,
    },
    // Chicks last: their parents must already be in the flock.
    {
      id: "demo-sub1",
      kind: "chick",
      chick_kind: "hen",
      parent_id: "demo-worker",
      project_name: "",
      title: "sub: shell audit",
      phase: "working",
      activity: Math.floor(t / 2),
      tool_class: "read",
      last_tool: "search_files",
      blocked: false,
      busy: true,
      last_activity_ts: Date.now() - 5_000,
    },
    {
      id: "demo-sub2",
      kind: "chick",
      chick_kind: "hen",
      parent_id: "demo-worker",
      project_name: "",
      title: "sub: yolk tests",
      phase: "working",
      activity: Math.floor(t / 2.5),
      tool_class: "command",
      last_tool: "run_tests",
      blocked: false,
      busy: true,
      last_activity_ts: Date.now() - 9_000,
    },
  ];
  // A rooster chick that periodically finishes and hops back into its parent.
  const sub3Cycle = t % 24;
  if (sub3Cycle < 20) {
    birds.push({
      id: "demo-sub3",
      kind: "chick",
      chick_kind: "rooster",
      parent_id: "demo-chat",
      project_name: "",
      title: "sub: fetch prices",
      phase: sub3Cycle < 16 ? "working" : "done",
      activity: Math.floor(Math.min(sub3Cycle, 16) / 3),
      tool_class: "read",
      last_tool: "fetch_url",
      blocked: false,
      busy: true,
      last_activity_ts: Date.now() - 3_000,
    });
  }
  const cycle = t % 30;
  if (cycle < 22) {
    birds.push({
      id: "demo-cycler",
      card_id: "demo-cycler",
      kind: "hen",
      project_name: "egg-farm",
      title: cycle < 14 ? "Wander the run" : "Head home",
      step: cycle < 14 ? "in_progress" : "done",
      phase: cycle < 14 ? "working" : "done",
      activity: Math.floor(Math.min(cycle, 14) / 2),
      tool_class: "command",
      last_tool: "Bash",
      blocked: false,
      busy: true,
      last_activity_ts: Date.now() - 65_000,
    });
  }
  return { birds, stats: { eggs: 14, tool_calls: 262 } };
}

// ── Reconciler + mirror ───────────────────────────────────────────────

const flock = {}; // card_id → Chicken
const mirrorEl = document.getElementById("coop-mirror");
const hudEl = document.getElementById("hud");
const emptyEl = document.getElementById("empty");
let lastError = null;

// Ids whose exit animation already played: don't respawn them while the
// roster entry lingers (done cards / completed chicks stay listed briefly).
const goneIds = {};

function reconcile(state) {
  syncStats(state.stats);
  syncPens(state.birds || state.chickens || []);
  const seen = {};
  for (const info of state.birds || state.chickens || []) {
    const id = info.id || info.card_id;
    seen[id] = true;
    if (goneIds[id]) continue; // exit played; entry is just lingering
    let c = flock[id];
    if (!c) {
      c = new Chicken(info);
      flock[id] = c;
    } else {
      c.title = info.title;
      c.parentId = info.parent_id || c.parentId;
      c.setPhase(info.phase);
      c.noteActivity(info.activity, info.tool_class);
      c.lastTool = info.last_tool || c.lastTool;
      c.busy = !!info.busy;
      if (info.last_activity_ts) c.lastActivityTs = info.last_activity_ts;
      c.setBlocked(!!info.blocked);
      c.setQuestion(info.question || null);
    }
  }
  for (const id of Object.keys(flock)) {
    if (!seen[id]) flock[id].setGone();
  }
  for (const id of Object.keys(goneIds)) {
    if (!seen[id]) delete goneIds[id];
  }
  syncMirror();
}

function syncMirror() {
  const rows = [];
  let hens = 0;
  let working = 0;
  let testing = 0;
  let questions = 0;
  let blockedN = 0;
  const extras = { rooster: 0, chick: 0, barred: 0, bantam: 0 };
  for (const id of Object.keys(flock)) {
    const c = flock[id];
    if (c.mode === "gone") {
      goneIds[id] = true;
      const el = mirrorEl.querySelector('[data-card-id="' + id + '"]');
      if (el) el.remove();
      delete flock[id];
      continue;
    }
    if (c.kind === "hen") {
      hens++;
      if (c.blocked) blockedN++;
      if (c.phase === "working") working++;
      if (c.phase === "testing") testing++;
    } else if (extras[c.kind] !== undefined) {
      extras[c.kind]++;
    }
    if (c.question) questions++;
    let el = mirrorEl.querySelector('[data-card-id="' + id + '"]');
    if (!el) {
      el = document.createElement("div");
      el.setAttribute("data-testid", "coop-chicken");
      el.setAttribute("data-card-id", id);
      mirrorEl.appendChild(el);
    }
    el.setAttribute("data-kind", c.kind);
    el.setAttribute("data-blocked", c.blocked ? "1" : "");
    el.setAttribute("data-phase", c.phase);
    el.setAttribute("data-anim", c.mode);
    el.setAttribute("data-activity", String(c.activitySeen));
    el.setAttribute("data-pecks", String(c.pecksPlayed));
    el.setAttribute("data-title", c.title);
    el.setAttribute("data-question", c.question ? c.question.id : "");
    if (c.parentId) el.setAttribute("data-parent", c.parentId);
    rows.push({
      cardId: id,
      kind: c.kind,
      parentId: c.parentId || null,
      title: c.title,
      phase: c.phase,
      anim: c.mode,
      activity: c.activitySeen,
      pecks: c.pecksPlayed,
      question: c.question ? c.question.id : null,
      blocked: !!c.blocked,
    });
  }
  window.__coopState = rows;
  const total = rows.length;
  const extraBits = [];
  if (extras.rooster)
    extraBits.push(
      extras.rooster + " rooster" + (extras.rooster === 1 ? "" : "s"),
    );
  if (extras.chick)
    extraBits.push(extras.chick + " chick" + (extras.chick === 1 ? "" : "s"));
  if (extras.barred) extraBits.push(extras.barred + " barred");
  if (extras.bantam)
    extraBits.push(
      extras.bantam + " bantam" + (extras.bantam === 1 ? "" : "s"),
    );
  if (blockedN) extraBits.push(blockedN + " blocked");
  hudEl.textContent =
    (renderer ? "" : "(no WebGL — roster only) ") +
    (lastError ? "reconnecting… " : "") +
    hens +
    " hen" +
    (hens === 1 ? "" : "s") +
    " out · " +
    working +
    " working · " +
    testing +
    " testing" +
    (extraBits.length ? " · " + extraBits.join(" · ") : "") +
    (questions > 0
      ? " · " + questions + " question" + (questions === 1 ? "" : "s")
      : "");
  emptyEl.style.display = total === 0 ? "flex" : "none";
}

// Test/demo hooks: force a peck, inspect or open a hen's pending question.
window.__coopTest = {
  kind(cardId) {
    const c = flock[cardId];
    return c ? c.kind : null;
  },
  birds() {
    return window.__coopState || [];
  },
  peck(cardId, cls) {
    const c = flock[cardId];
    if (c) c.peckQueue.push(cls || "command");
    return !!c;
  },
  question(cardId) {
    const c = flock[cardId];
    return c && c.question ? c.question.id : null;
  },
  openQuestion(cardId) {
    const c = flock[cardId];
    if (c && c.question) {
      openQuestionModal(c);
      return true;
    }
    return false;
  },
  hover(cardId) {
    hoverId = cardId;
    return !!flock[cardId];
  },
  openInfo(cardId) {
    const c = flock[cardId];
    if (!c) return false;
    openInfoPopover(c, { clientX: innerWidth / 2, clientY: innerHeight / 2 });
    return true;
  },
  feed(x, z) {
    return tryScatterFeed(new Vector3(x, 0, z), true);
  },
  feedKernels() {
    let n = 0;
    for (const p of feedPiles) n += p.live.length + p.falling.length;
    return n;
  },
  camMode() {
    return camMode;
  },
  setCam(mode) {
    if (!CAM_MODES.includes(mode)) return false;
    camMode = mode;
    camBtn.paint();
    return true;
  },
};

// ── Picking: click a hen with a question to open the Q&A modal ────────

function initPicking() {
  if (!renderer) return;
  const raycaster = new Raycaster();
  const pt = new Vector2();
  const pick = (ev) => {
    const rect = renderer.domElement.getBoundingClientRect();
    pt.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    pt.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pt, camera);
    const roots = [];
    for (const id of Object.keys(flock)) {
      const c = flock[id];
      if (c.viz && c.mode !== "gone") roots.push(c.viz.root);
    }
    const hits = raycaster.intersectObjects(roots, true);
    for (const h of hits) {
      let o = h.object;
      while (o && !(o.userData && o.userData.cardId)) o = o.parent;
      if (o) return flock[o.userData.cardId] || null;
    }
    return null;
  };
  // Where the click ray meets the ground plane (null: sky / off-field).
  const groundPoint = (ev) => {
    const rect = renderer.domElement.getBoundingClientRect();
    pt.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    pt.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pt, camera);
    const r = raycaster.ray;
    if (r.direction.y >= -1e-4) return null;
    const t = -r.origin.y / r.direction.y;
    const p = new Vector3(
      r.origin.x + r.direction.x * t,
      0,
      r.origin.z + r.direction.z * t,
    );
    if (
      p.x < FIELD.minX ||
      p.x > FIELD.maxX ||
      p.z < FIELD.minZ ||
      p.z > FIELD.maxZ
    )
      return null;
    return p;
  };
  renderer.domElement.addEventListener("pointerdown", (ev) => {
    const c = pick(ev);
    if (c && c.question) {
      // A pending question wins over the info popover.
      closeInfoPopover();
      openQuestionModal(c);
    } else if (c) {
      openInfoPopover(c, ev);
    } else {
      closeInfoPopover();
      const gp = groundPoint(ev);
      if (gp) tryScatterFeed(gp);
    }
  });
  let hoverAt = 0;
  renderer.domElement.addEventListener("pointermove", (ev) => {
    const now = performance.now();
    if (now - hoverAt < 60) return;
    hoverAt = now;
    const c = pick(ev);
    hoverId = c ? c.cardId : null;
    renderer.domElement.style.cursor = c ? "pointer" : "default";
  });
  renderer.domElement.addEventListener("pointerleave", () => {
    hoverId = null;
  });
}

// ── Q&A modal: question + enough context to answer it ─────────────────

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c];
  });
}

// Tiny markdown renderer for question/card text: fenced code blocks, inline
// code, bold, and "- " bullet lists. Everything else is escaped verbatim.
function mdLite(text) {
  const lines = String(text || "").split("\n");
  const out = [];
  let list = false;
  const closeList = () => {
    if (list) {
      out.push("</ul>");
      list = false;
    }
  };
  const inline = (s) => {
    let h = escapeHtml(s);
    h = h.replace(/`([^`]+)`/g, "<code>$1</code>");
    h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    return h;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // swallow the closing fence
      closeList();
      out.push(
        '<pre class="coop-code"><code>' +
          escapeHtml(buf.join("\n")) +
          "</code></pre>",
      );
      continue;
    }
    if (/^\s*[-*] /.test(line)) {
      if (!list) {
        out.push('<ul class="coop-ul">');
        list = true;
      }
      out.push("<li>" + inline(line.replace(/^\s*[-*] /, "")) + "</li>");
      i++;
      continue;
    }
    closeList();
    if (line.trim() === "") out.push('<div class="coop-gap"></div>');
    else out.push("<p>" + inline(line) + "</p>");
    i++;
  }
  closeList();
  return out.join("");
}

// Inline SVG of the card workflow with the hen's current step highlighted —
// context for "where is this card right now" at a glance.
function pipelineSvg(phase) {
  const labels = ["backlog", "todo", "working", "testing", "done"];
  const hot =
    phase === "testing" ? 3 : phase === "done" || phase === "wont_do" ? 4 : 2;
  const w = 92;
  const gap = 16;
  const parts = [];
  let x = 4;
  for (let i = 0; i < labels.length; i++) {
    const isHot = i === hot;
    parts.push(
      '<rect x="' +
        x +
        '" y="8" rx="9" width="' +
        w +
        '" height="30" fill="' +
        (isHot ? "#f5a623" : "#efebe1") +
        '" stroke="' +
        (isHot ? "#b97a10" : "#ddd5c4") +
        '"/>',
    );
    parts.push(
      '<text x="' +
        (x + w / 2) +
        '" y="28" text-anchor="middle" font-size="13" font-weight="' +
        (isHot ? "700" : "500") +
        '" fill="' +
        (isHot ? "#3a2a08" : "#6f6a60") +
        '" font-family="system-ui, sans-serif">' +
        labels[i] +
        "</text>",
    );
    if (i < labels.length - 1) {
      parts.push(
        '<path d="M ' +
          (x + w + 3) +
          " 23 l " +
          (gap - 7) +
          ' 0" stroke="#c8c3b8" stroke-width="2" marker-end="url(#coop-arr)"/>',
      );
    }
    x += w + gap;
  }
  parts.push(
    '<text x="' +
      (4 + hot * (w + gap) + w / 2) +
      '" y="56" text-anchor="middle" font-size="11" fill="#a07408" font-family="system-ui, sans-serif">this hen is here</text>',
  );
  return (
    '<svg viewBox="0 0 ' +
    (x - gap + 8) +
    ' 62" width="100%" role="img" aria-label="card workflow position">' +
    '<defs><marker id="coop-arr" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="#c8c3b8"/></marker></defs>' +
    parts.join("") +
    "</svg>"
  );
}

let modalEl = null;
let modalCtx = null; // { chicken, q, questions }

const MODAL_CSS =
  "#coop-modal{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(24,30,20,0.45);z-index:50;font:14px/1.5 system-ui,sans-serif}" +
  "#coop-modal[hidden]{display:none}" +
  ".coop-modal-panel{width:min(600px,calc(100vw - 48px));max-height:min(82vh,720px);display:flex;flex-direction:column;background:#fdfbf7;color:#2f2a26;border-radius:14px;box-shadow:0 18px 50px rgba(20,16,8,0.35);overflow:hidden}" +
  ".coop-modal-head{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid #eee7da}" +
  ".coop-modal-dot{width:26px;height:26px;border-radius:50%;background:#f5a623;color:#3a2a08;font-weight:800;display:flex;align-items:center;justify-content:center;flex:none}" +
  ".coop-modal-title{font-weight:650;font-size:15px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
  ".coop-modal-close{border:0;background:none;font-size:20px;line-height:1;color:#8a8378;cursor:pointer;padding:4px 8px;border-radius:8px}" +
  ".coop-modal-close:hover{background:#f0ebe0;color:#2f2a26}" +
  ".coop-modal-body{padding:14px 18px;overflow-y:auto}" +
  ".coop-ctx{background:#f6f1e7;border:1px solid #eadfc9;border-radius:10px;padding:10px 12px;margin-bottom:14px}" +
  ".coop-ctx-title{font-weight:650;margin-bottom:2px}" +
  ".coop-ctx-meta{color:#7a7168;font-size:12.5px;font-weight:400}" +
  ".coop-ctx svg{display:block;margin:8px 0 2px}" +
  ".coop-ctx-desc{margin-top:8px;border-top:1px dashed #e0d5bd;padding-top:8px}" +
  ".coop-ctx-desc summary{cursor:pointer;color:#7a7168;font-size:12.5px}" +
  ".coop-ctx-desc p{margin:6px 0 0}" +
  ".coop-q{margin-bottom:16px}" +
  ".coop-q-head{display:inline-block;background:#efe7d6;color:#6f6350;font-size:11.5px;font-weight:650;letter-spacing:0.4px;text-transform:uppercase;border-radius:6px;padding:2px 8px;margin-bottom:6px}" +
  ".coop-q-text p{margin:0 0 6px}" +
  ".coop-code{background:#efe9dc;border-radius:8px;padding:8px 10px;overflow-x:auto;margin:6px 0;font-size:12.5px}" +
  ".coop-code code,.coop-q-text code,.coop-ctx code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}" +
  ".coop-q-text code,.coop-ctx code{background:#efe9dc;border-radius:5px;padding:1px 4px}" +
  ".coop-opt{display:flex;gap:8px;align-items:baseline;padding:8px 10px;border:1px solid #e6ddca;border-radius:10px;margin:6px 0;cursor:pointer;transition:border-color 0.12s,background 0.12s}" +
  ".coop-opt:hover{background:#faf5ea}" +
  ".coop-opt:has(input:checked){border-color:#d99a1e;background:#fdf4e0}" +
  ".coop-opt input{accent-color:#b97a10}" +
  ".coop-opt-label{font-weight:600}" +
  ".coop-opt-desc{color:#7a7168;font-size:12.5px}" +
  ".coop-free{width:100%;box-sizing:border-box;margin-top:6px;padding:8px 10px;border:1px solid #e6ddca;border-radius:10px;font:inherit;background:#fff}" +
  ".coop-free:focus{outline:2px solid #e9c470;border-color:#d99a1e}" +
  ".coop-modal-foot{display:flex;align-items:center;gap:10px;padding:12px 18px;border-top:1px solid #eee7da}" +
  ".coop-modal-err{color:#b3402a;font-size:12.5px;flex:1}" +
  ".coop-btn{border:0;border-radius:10px;padding:9px 16px;font:600 13.5px system-ui,sans-serif;cursor:pointer}" +
  ".coop-btn[disabled]{opacity:0.55;cursor:default}" +
  ".coop-btn-primary{background:#b97a10;color:#fff}" +
  ".coop-btn-primary:not([disabled]):hover{background:#a06a0c}" +
  ".coop-btn-ghost{background:none;color:#7a7168;border:1px solid #ddd3c0}" +
  ".coop-btn-ghost:hover{background:#f0ebe0}" +
  ".coop-gap{height:6px}" +
  ".coop-ul{margin:4px 0 8px;padding-left:20px}";

function ensureModalDom() {
  if (modalEl) return modalEl;
  const style = document.createElement("style");
  style.textContent = MODAL_CSS;
  document.head.appendChild(style);
  modalEl = document.createElement("div");
  modalEl.id = "coop-modal";
  modalEl.setAttribute("data-testid", "coop-question-modal");
  modalEl.hidden = true;
  modalEl.innerHTML =
    '<div class="coop-modal-panel" role="dialog" aria-modal="true"></div>';
  modalEl.addEventListener("click", (e) => {
    if (e.target === modalEl) closeModal();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modalEl && !modalEl.hidden) closeModal();
  });
  const panel = modalEl.querySelector(".coop-modal-panel");
  panel.addEventListener("click", (e) => {
    const act =
      e.target && e.target.closest ? e.target.closest("[data-act]") : null;
    if (!act) return;
    const a = act.getAttribute("data-act");
    if (a === "close") closeModal();
    else if (a === "dismiss") submitModal(true);
    else if (a === "answer") submitModal(false);
  });
  panel.addEventListener("input", refreshAnswerEnabled);
  panel.addEventListener("change", refreshAnswerEnabled);
  document.body.appendChild(modalEl);
  return modalEl;
}

function closeModal() {
  if (modalEl) modalEl.hidden = true;
  modalCtx = null;
}

function collectAnswers() {
  const answers = {};
  let complete = true;
  modalEl.querySelectorAll(".coop-q").forEach((qEl) => {
    const idx = qEl.getAttribute("data-idx");
    const free = qEl.querySelector(".coop-free");
    const typed =
      free && typeof free.value === "string" ? free.value.trim() : "";
    if (typed !== "") {
      answers[idx] = typed;
      return;
    }
    const checked = [];
    qEl
      .querySelectorAll("input:checked")
      .forEach((inp) => checked.push(inp.value));
    if (checked.length > 0) answers[idx] = checked.join(", ");
    else complete = false;
  });
  return { answers, complete };
}

async function submitModal(rejected) {
  if (!modalCtx) return;
  const { chicken, q } = modalCtx;
  let answers = {};
  if (!rejected) {
    const got = collectAnswers();
    if (!got.complete) return;
    answers = got.answers;
  }
  const answerBtn = modalEl.querySelector('[data-act="answer"]');
  const dismissBtn = modalEl.querySelector('[data-act="dismiss"]');
  const errEl = modalEl.querySelector(".coop-modal-err");
  answerBtn.disabled = true;
  dismissBtn.disabled = true;
  errEl.textContent = "";
  try {
    if (!DEMO) {
      const res = await apiFetch("/api/plugin-ui/chicken-coop/answer", {
        method: "POST",
        body: JSON.stringify({
          session_id: q.session_id,
          question_id: q.id,
          answers,
          rejected: !!rejected,
        }),
      });
      if (res.status !== 200) {
        let msg = "answer failed (" + res.status + ")";
        try {
          msg = JSON.parse(res.body).error || msg;
        } catch (e) {
          /* keep the status message */
        }
        throw new Error(msg);
      }
    }
    chicken.answeredQid = q.id;
    chicken.setQuestion(null);
    if (!rejected) chicken.celebrateT = 0.9;
    closeModal();
    syncMirror();
  } catch (e) {
    errEl.textContent = String(e && e.message ? e.message : e);
    answerBtn.disabled = false;
    dismissBtn.disabled = false;
  }
}

function refreshAnswerEnabled() {
  if (!modalEl || modalEl.hidden) return;
  const answerBtn = modalEl.querySelector('[data-act="answer"]');
  if (answerBtn) answerBtn.disabled = !collectAnswers().complete;
}

const PHASE_BLURB = {
  working: "out in the run, working",
  testing: "on the nest — card in testing",
  done: "heading home",
  wont_do: "heading home",
};

/// Context line for the modal: workflow blurb for card hens, session-flavored
/// wording for every other bird.
function contextBlurb(chicken) {
  if (chicken.kind && chicken.kind !== "hen") {
    const what = KIND_LABEL[chicken.kind] || "session";
    return chicken.phase === "working"
      ? "live " + what + " session"
      : what + " session winding down";
  }
  return PHASE_BLURB[chicken.phase] || chicken.phase;
}
function openQuestionModal(chicken) {
  const q = chicken.question;
  if (!q) return;
  const d = q.data || {};
  // Worker questions carry a `questions` array; plugin-emitted ones a single
  // `question` + string options. Normalize both.
  let questions = Array.isArray(d.questions) ? d.questions.filter(Boolean) : [];
  if (questions.length === 0) {
    questions = [
      {
        question:
          typeof d.question === "string"
            ? d.question
            : "The agent needs your input.",
        header: "Question",
        options: Array.isArray(d.options)
          ? d.options.map((o) =>
              typeof o === "string" ? { label: o, description: "" } : o,
            )
          : [],
        multiSelect: false,
      },
    ];
  }
  modalCtx = { chicken, q, questions };

  const el = ensureModalDom();
  const cardTitle =
    typeof d.cardTitle === "string" && d.cardTitle
      ? d.cardTitle
      : chicken.title;
  const project =
    typeof d.projectName === "string" && d.projectName
      ? d.projectName
      : chicken.project;
  const desc =
    typeof d.cardDescription === "string" && d.cardDescription.trim() !== ""
      ? d.cardDescription
      : null;
  const activityLine =
    chicken.activitySeen > 0
      ? chicken.activitySeen +
        " tool call" +
        (chicken.activitySeen === 1 ? "" : "s") +
        (chicken.lastTool ? " · last: " + chicken.lastTool : "")
      : "no tool activity yet";

  const qHtml = questions
    .map((qq, i) => {
      const header = escapeHtml(
        qq.header ||
          (questions.length > 1 ? "Question " + (i + 1) : "Question"),
      );
      const opts = Array.isArray(qq.options)
        ? qq.options.filter((o) => o && typeof o.label === "string")
        : [];
      const type = qq.multiSelect ? "checkbox" : "radio";
      const optHtml = opts
        .map(
          (o) =>
            '<label class="coop-opt"><input type="' +
            type +
            '" name="coop-q-' +
            i +
            '" value="' +
            escapeHtml(o.label) +
            '"><span><span class="coop-opt-label">' +
            escapeHtml(o.label) +
            "</span>" +
            (o.description
              ? ' <span class="coop-opt-desc">— ' +
                escapeHtml(o.description) +
                "</span>"
              : "") +
            "</span></label>",
        )
        .join("");
      return (
        '<div class="coop-q" data-idx="' +
        i +
        '">' +
        '<div class="coop-q-head">' +
        header +
        "</div>" +
        '<div class="coop-q-text">' +
        mdLite(qq.question || "") +
        "</div>" +
        '<div class="coop-opts">' +
        optHtml +
        "</div>" +
        '<input class="coop-free" type="text" data-testid="coop-q-free-' +
        i +
        '" placeholder="' +
        (opts.length ? "Or type a custom answer…" : "Type your answer…") +
        '">' +
        "</div>"
      );
    })
    .join("");

  el.querySelector(".coop-modal-panel").innerHTML =
    '<div class="coop-modal-head">' +
    '<div class="coop-modal-dot">!</div>' +
    '<div class="coop-modal-title">' +
    escapeHtml(cardTitle) +
    ' <span class="coop-ctx-meta">needs your answer</span></div>' +
    '<button type="button" class="coop-modal-close" data-act="close" aria-label="Close">×</button>' +
    "</div>" +
    '<div class="coop-modal-body">' +
    '<div class="coop-ctx" data-testid="coop-question-context">' +
    '<div class="coop-ctx-title">' +
    escapeHtml(cardTitle) +
    "</div>" +
    '<div class="coop-ctx-meta">' +
    escapeHtml(project || "") +
    (project ? " · " : "") +
    escapeHtml(contextBlurb(chicken)) +
    " · " +
    escapeHtml(activityLine) +
    "</div>" +
    (chicken.kind === "hen" ? pipelineSvg(chicken.phase) : "") +
    (desc
      ? '<div class="coop-ctx-desc"><details' +
        (desc.length < 280 ? " open" : "") +
        "><summary>Card description</summary>" +
        mdLite(desc) +
        "</details></div>"
      : "") +
    "</div>" +
    qHtml +
    "</div>" +
    '<div class="coop-modal-foot">' +
    '<span class="coop-modal-err" data-testid="coop-question-error"></span>' +
    '<button type="button" class="coop-btn coop-btn-ghost" data-act="dismiss" data-testid="coop-question-dismiss">Dismiss</button>' +
    '<button type="button" class="coop-btn coop-btn-primary" data-act="answer" data-testid="coop-question-answer" disabled>Answer</button>' +
    "</div>";

  el.hidden = false;
  const first = el.querySelector(".coop-opt input, .coop-free");
  if (first) first.focus();
}
// ── Info popover: click any bird for identity + status at a glance ────

const POP_CSS =
  "#coop-pop{position:fixed;z-index:40;width:232px;background:#fdfbf7;color:#2f2a26;" +
  "border:1px solid #e6ddca;border-radius:12px;box-shadow:0 10px 30px rgba(20,16,8,0.28);" +
  "font:13px/1.45 system-ui,sans-serif;padding:10px 12px;opacity:0;transform:translateY(4px);" +
  "transition:opacity 0.14s ease,transform 0.14s ease}" +
  "#coop-pop.coop-pop-in{opacity:1;transform:translateY(0)}" +
  "#coop-pop[hidden]{display:none}" +
  ".coop-pop-name{font-weight:650;font-size:14px;margin-right:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
  ".coop-pop-breed{color:#a07408;font-size:11.5px;font-weight:650;letter-spacing:0.3px;text-transform:uppercase;margin:1px 0 6px}" +
  ".coop-pop-row{display:flex;gap:8px;margin:2px 0;color:#5c554c}" +
  ".coop-pop-k{flex:none;width:60px;color:#8a8378;font-size:12px}" +
  ".coop-pop-v{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
  ".coop-pop-x{position:absolute;top:6px;right:6px;border:0;background:none;color:#8a8378;font-size:16px;line-height:1;cursor:pointer;padding:2px 6px;border-radius:6px}" +
  ".coop-pop-x:hover{background:#f0ebe0;color:#2f2a26}";

let popEl = null;

function ensurePopDom() {
  if (popEl) return popEl;
  const style = document.createElement("style");
  style.textContent = POP_CSS;
  document.head.appendChild(style);
  popEl = document.createElement("div");
  popEl.id = "coop-pop";
  popEl.setAttribute("data-testid", "coop-info-popover");
  popEl.style.position = "fixed";
  popEl.hidden = true;
  document.body.appendChild(popEl);
  popEl.addEventListener("click", (e) => {
    if (e.target && e.target.closest && e.target.closest(".coop-pop-x"))
      closeInfoPopover();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeInfoPopover();
  });
  // Click-outside closes. Canvas clicks are excluded: picking decides
  // there (another bird reopens, empty ground closes).
  window.addEventListener("pointerdown", (e) => {
    if (popEl.hidden || popEl.contains(e.target)) return;
    if (renderer && e.target === renderer.domElement) return;
    closeInfoPopover();
  });
  return popEl;
}

function closeInfoPopover() {
  if (popEl) {
    popEl.hidden = true;
    popEl.classList.remove("coop-pop-in");
  }
}

/// Rough age wording for the popover's "seen" row.
function fmtAge(ts) {
  if (!ts) return "unknown";
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 45) return "just now";
  if (s < 5400) return Math.round(s / 60) + "m ago";
  if (s < 129600) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
}

/// Popover phase wording: the run-level view (walking home / idle), not
/// the raw card step.
function popPhase(c) {
  if (c.phase === "done" || c.phase === "wont_do" || c.mode === "homeArrive")
    return "walking home";
  if (c.phase === "testing") return "testing";
  return c.busy || c.peckQueue.length > 0 || c.mode === "peck"
    ? "working"
    : "idle";
}

function openInfoPopover(chicken, ev) {
  const el = ensurePopDom();
  const breed =
    (BREED_NAME[chicken.kind] || chicken.kind) +
    " · " +
    (KIND_LABEL[chicken.kind] || "session");
  const acts =
    chicken.activitySeen > 0
      ? chicken.activitySeen +
        " tool call" +
        (chicken.activitySeen === 1 ? "" : "s") +
        (chicken.lastTool ? " · " + chicken.lastTool : "")
      : "none yet";
  const rows = [
    ["phase", popPhase(chicken)],
    ["project", chicken.project || "—"],
    ["activity", acts],
    ["seen", fmtAge(chicken.lastActivityTs)],
  ];
  el.innerHTML =
    '<button type="button" class="coop-pop-x" aria-label="Close">×</button>' +
    '<div class="coop-pop-name">' +
    escapeHtml(chicken.title || "") +
    "</div>" +
    '<div class="coop-pop-breed">' +
    escapeHtml(breed) +
    "</div>" +
    rows
      .map(
        (r) =>
          '<div class="coop-pop-row"><span class="coop-pop-k">' +
          r[0] +
          '</span><span class="coop-pop-v">' +
          escapeHtml(r[1]) +
          "</span></div>",
      )
      .join("");
  el.hidden = false;
  // Place near the click, clamped to the viewport (measure after unhide).
  const W = 232;
  const pad = 10;
  const x = Math.min(Math.max(ev.clientX + 12, pad), innerWidth - W - pad);
  el.style.left = x + "px";
  el.style.top = pad + "px";
  const h = el.offsetHeight || 150;
  const y = Math.min(Math.max(ev.clientY + 12, pad), innerHeight - h - pad);
  el.style.top = y + "px";
  requestAnimationFrame(() => el.classList.add("coop-pop-in"));
}
// ── Poll + main loop ──────────────────────────────────────────────────

let demoClock = 0;

async function poll() {
  try {
    if (DEMO) {
      reconcile(demoState(demoClock));
      // Auto-open each demo question once (worker first, then the rooster's
      // card-less one) so the Q&A flow is visible without hunting birds.
      const dw = flock["demo-worker"];
      if (!FOCUS_ID && !window.__demoQuestionOpened && dw && dw.question) {
        window.__demoQuestionOpened = true;
        openQuestionModal(dw);
      }
      const dc = flock["demo-chat"];
      if (
        !FOCUS_ID &&
        !window.__demoChatQuestionOpened &&
        (!modalEl || modalEl.hidden) &&
        dc &&
        dc.question
      ) {
        window.__demoChatQuestionOpened = true;
        openQuestionModal(dc);
      }
      // Showcase the identity UI: sweep the hover name tag across the
      // flock (a real pointer re-picks on the next mouse move), and open
      // one info popover once the question modals are out of the way.
      if (!FOCUS_ID) {
        const ids = Object.keys(flock).filter(
          (id) => flock[id].mode !== "gone",
        );
        if (ids.length) hoverId = ids[Math.floor(demoClock / 4) % ids.length];
        if (
          demoClock > 17 &&
          !window.__demoInfoOpened &&
          (!modalEl || modalEl.hidden) &&
          flock["demo-cron"]
        ) {
          window.__demoInfoOpened = true;
          openInfoPopover(flock["demo-cron"], {
            clientX: innerWidth * 0.6,
            clientY: innerHeight * 0.3,
          });
        }
      }
    } else {
      const res = await apiFetch("/api/plugin-ui/chicken-coop/state");
      if (res.status !== 200) throw new Error("state " + res.status);
      reconcile(JSON.parse(res.body));
      lastError = null;
    }
  } catch (e) {
    lastError = String(e && e.message ? e.message : e);
    syncMirror(); // keep HUD honest; hens stay put on transient errors
  } finally {
    schedulePoll();
  }
}

// ?focus=<bird id> (demo): hold the camera on one bird for close-up model
// shots; the bird pauses its wandering while focused.
const FOCUS_ID = (() => {
  try {
    return new URLSearchParams(location.search).get("focus");
  } catch (e) {
    return null;
  }
})();
// ?yaw=<radians> (with ?focus): pose the focused bird at a fixed heading so
// profile shots are unambiguous.
const FOCUS_YAW = (() => {
  try {
    const v = new URLSearchParams(location.search).get("yaw");
    return v === null ? null : parseFloat(v);
  } catch (e) {
    return null;
  }
})();
// ── Camera modes ──────────────────────────────────────────────────────
//
// Corner button cycles Free (the classic fixed view) → Follow (a smooth
// crane shot tracking whichever bird was most recently active) → Chicken
// Cam (head-height view from that bird with a gentle bob). Escape returns
// to Free. Every transition eases — no cuts.

const CAM_HOME_POS = new Vector3(0, 9.4, 14.2);
const CAM_HOME_LOOK = new Vector3(-0.3, 0.2, -1.6);
const CAM_MODES = ["free", "follow", "chicken"];
const CAM_LABEL = { free: "🎥 Free", follow: "🎥 Follow", chicken: "🐔 Cam" };
// ?cam=<free|follow|chicken> (demo/tests): start in that camera mode.
let camMode = (() => {
  try {
    const v = new URLSearchParams(location.search).get("cam");
    return CAM_MODES.includes(v) ? v : "free";
  } catch (e) {
    return "free";
  }
})();
let lastActiveId = null;
const camPosS = CAM_HOME_POS.clone();
const camLookS = CAM_HOME_LOOK.clone();

function markActive(c) {
  lastActiveId = c.cardId;
}

/// The bird the tracking modes watch: the last one to show tool activity,
/// else any bird still on the field.
function activeBird() {
  const c = lastActiveId ? flock[lastActiveId] : null;
  if (c && c.viz && c.mode !== "gone") return c;
  for (const id of Object.keys(flock)) {
    const o = flock[id];
    if (o.viz && o.mode !== "gone") return o;
  }
  return null;
}

// Corner camera-mode button, next to the mute toggle.
const camBtn = (() => {
  const b = document.createElement("button");
  b.id = "coop-cam";
  b.setAttribute("data-testid", "coop-cam");
  b.title = "Cycle camera mode (Esc: free)";
  b.style.cssText =
    "position:fixed;right:54px;bottom:12px;z-index:20;height:34px;" +
    "padding:0 10px;border:none;border-radius:8px;" +
    "background:rgba(255,255,255,0.82);font:13px system-ui,sans-serif;" +
    "color:#333;cursor:pointer;";
  const paintCam = () => {
    b.textContent = CAM_LABEL[camMode];
    b.setAttribute("data-mode", camMode);
  };
  b.addEventListener("click", () => {
    camMode = CAM_MODES[(CAM_MODES.indexOf(camMode) + 1) % CAM_MODES.length];
    paintCam();
  });
  document.body.appendChild(b);
  paintCam();
  return { el: b, paint: paintCam };
})();

// Escape drops back to Free — unless a modal/popover is up, whose own
// Escape handling wins (closing it shouldn't also yank the camera).
window.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape" || camMode === "free") return;
  if (modalEl && !modalEl.hidden) return;
  if (popEl && !popEl.hidden) return;
  camMode = "free";
  camBtn.paint();
});

function updateCamera(dt) {
  if (!renderer || FOCUS_ID) return;
  let pos = CAM_HOME_POS;
  let look = CAM_HOME_LOOK;
  const c = camMode === "free" ? null : activeBird();
  if (c) {
    const p = c.posV;
    if (camMode === "follow") {
      pos = new Vector3(p.x + 2.6, 3.4, p.z + 4.6);
      look = new Vector3(p.x, 0.5, p.z);
    } else {
      // Chicken Cam: a beak's-eye POV — just ahead of the head (so the
      // bird's own body stays behind the lens), looking where the bird
      // looks, with a gentle bob from gait plus a slow idle sway.
      const bob =
        Math.sin(c.walkPhase) * 0.03 +
        Math.sin(performance.now() / 450) * 0.015;
      const fwd = c.kind === "chick" ? 0.35 : 0.6;
      const headY = (c.kind === "chick" ? 0.38 : 0.68) + bob;
      pos = new Vector3(
        p.x + Math.sin(c.yaw) * fwd,
        headY,
        p.z + Math.cos(c.yaw) * fwd,
      );
      look = new Vector3(
        p.x + Math.sin(c.yaw) * 4,
        0.3 + bob * 0.5,
        p.z + Math.cos(c.yaw) * 4,
      );
    }
  }
  const k = 1 - Math.exp(-2.6 * dt);
  camPosS.lerp(pos, k);
  camLookS.lerp(look, k);
  camera.position.copy(camPosS);
  camera.lookAt(camLookS);
}

let lastT = performance.now();
let running = false; // main-loop gate: false stops the rAF chain entirely
let glLost = false; // true between webglcontextlost and webglcontextrestored
let pollTimer = null;

// Single-timer poll scheduler so hide/show can retarget the cadence without
// ever stacking two loops. When hidden pollDelay returns null and polling
// parks entirely (zero background fetches); a fresh poll fires on show.
function schedulePoll() {
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  const delay = pollDelay(document.hidden, POLL_MS);
  if (delay !== null) pollTimer = setTimeout(poll, delay);
}

// Explicit render-loop start/stop so a hidden tab does zero rendering —
// belt-and-braces over the browser's own rAF throttling. startLoop is
// idempotent; on restart lastT resets so the first dt isn't a stale gap.
function startLoop() {
  if (running) return;
  running = true;
  lastT = performance.now();
  requestAnimationFrame(animate);
}
function stopLoop() {
  running = false;
}

function animate() {
  if (!running) return; // stopped while hidden — don't re-arm the loop
  requestAnimationFrame(animate);
  const now = performance.now();
  const dt = Math.min((now - lastT) / 1000, 0.05);
  lastT = now;
  demoClock += dt;
  let dirty = false;
  for (const id of Object.keys(flock)) {
    const c = flock[id];
    const before = c.mode;
    c.update(dt);
    if (c.mode !== before) dirty = true;
  }
  if (dirty) syncMirror();
  updatePuffs(dt);
  updateDayNight();
  updateFeed(dt);
  if (FOCUS_ID && renderer) {
    // Model-inspection mode: only the focused bird and its family (parent /
    // chicks) stay visible and labels hide, so nothing photobombs the shot.
    const c = flock[FOCUS_ID];
    for (const id of Object.keys(flock)) {
      const o = flock[id];
      o.pauseUntil = Infinity;
      if (o.label) o.label.visible = false;
      if (o.viz) {
        const family =
          id === FOCUS_ID ||
          o.parentId === FOCUS_ID ||
          (c && c.parentId === id);
        o.viz.root.visible = family;
      }
    }
    if (c && c.viz && c.mode !== "gone") {
      if (FOCUS_YAW !== null && !Number.isNaN(FOCUS_YAW)) {
        c.posV.set(2.5, 0, 1.5); // clear of the coop for an unobstructed shot
        c.yaw = FOCUS_YAW;
        c.target = null;
        if (c.mode === "walk" || c.mode === "emerge") c.mode = "wander";
      }
      const p = c.posV;
      // Approach from the side opposite the parent so it can't block the
      // lens; frame chicks lower and closer.
      let ox = 1.7;
      let oz = 2.2;
      const par = c.parentId ? flock[c.parentId] : null;
      if (par) {
        const dx = p.x - par.posV.x;
        const dz = p.z - par.posV.z;
        const dl = Math.hypot(dx, dz) || 1;
        const r = c.kind === "chick" ? 1.6 : 2.4;
        ox = (dx / dl) * r;
        oz = (dz / dl) * r;
      }
      const camY = c.kind === "chick" ? 0.85 : 1.35;
      const lookY = c.kind === "chick" ? 0.28 : 0.55;
      camera.position.set(p.x + ox, camY, p.z + oz);
      camera.lookAt(p.x, lookY, p.z);
    }
  }
  updateCamera(dt);
  if (renderer && !glLost) renderer.render(scene, camera);
}

// Hidden-tab pause + WebGL context-loss guards. Installed after initScene so
// renderer.domElement exists when WebGL is available at all.
function installGuards() {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopLoop();
      sound.suspend();
      schedulePoll(); // pollDelay(hidden) → null → polling parks
    } else {
      sound.resume();
      startLoop();
      // One fresh poll now: reconcile despawns/roster before the next frame,
      // so nothing stale lingers and there's no catch-up burst (the peck cap
      // holds regardless of how long we were away).
      poll();
    }
  });
  if (!renderer) return;
  const canvas = renderer.domElement;
  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault(); // required for 'restored' to fire
    glLost = true; // skip rendering the dead context — no black-canvas flash
  });
  canvas.addEventListener("webglcontextrestored", () => {
    // three.js re-uploads GL resources lazily on the next render; clearing
    // the flag lets the loop repaint them cleanly.
    glLost = false;
    if (!running && !document.hidden) startLoop();
  });
}

initScene();
initPicking();
installGuards();
syncMirror();
poll();
startLoop();
