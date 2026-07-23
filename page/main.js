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

// ── Layout constants ──────────────────────────────────────────────────

const FIELD = { minX: -6, maxX: 8, minZ: -5.5, maxZ: 5.5 };
const COOP_POS = new Vector3(-9.6, 0, -2.2);
const DOOR_POS = new Vector3(-7.8, 0, -1.2); // just outside the coop door
const NEST_BASE = new Vector3(9.0, 0, -4.6); // nests fan out along +z
const NEST_GAP = 2.1;
const WALK_SPEED = 1.7;
const HOME_SPEED = 2.4;
const POLL_MS = 1000;
const MAX_QUEUED_PECKS = 3;

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

// ── Scene setup (guarded: headless fallback keeps state + mirror alive) ──

let renderer = null;
let scene = null;
let camera = null;

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

  scene.add(new HemisphereLight(0xd8ecff, 0x6b8f4e, 0.85));
  scene.add(new AmbientLight(0xffffff, 0.25));
  const sun = new DirectionalLight(0xfff2d8, 1.6);
  sun.position.set(-9, 14, 8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -20;
  sun.shadow.camera.right = 20;
  sun.shadow.camera.top = 20;
  sun.shadow.camera.bottom = -20;
  scene.add(sun);

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
function drawFeathers(ctx, w, h, plumage, rnd) {
  ctx.fillStyle = cssHex(plumage);
  ctx.fillRect(0, 0, w, h);
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
  const opening = box(0.06, 1.15, 0.9, 0x241610);
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
  const glass = new Mesh(new BoxGeometry(0.04, 0.7, 0.7), lambert(0xaed2e8));
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

// ── Chicken model ─────────────────────────────────────────────────────
//
// Rounded hen out of ellipsoids with a speckled feather texture. The
// returned handles and pivot semantics are the animation contract used by
// Chicken.update(): neckG.rotation.x dips the head to peck, wing rotation.z
// lifts the wings, legs swing rotation.x at the hip, legs hide when nesting.

const FEATHER_CACHE = new Map();
function featherMats(plumage) {
  let mats = FEATHER_CACHE.get(plumage);
  if (!mats) {
    const rnd = mulberry32(plumage);
    const tex = makeTexture(
      96,
      96,
      (c, w, h) => drawFeathers(c, w, h, plumage, rnd),
      2,
      2,
    );
    mats = {
      base: lambertMap(tex),
      light: lambert(shadeHex(plumage, 30)),
      dark: lambert(shadeHex(plumage, -42)),
    };
    FEATHER_CACHE.set(plumage, mats);
  }
  return mats;
}

function buildChickenMesh(seedRnd) {
  const plumage = PLUMAGE[Math.floor(seedRnd() * PLUMAGE.length)];
  const M = featherMats(plumage);
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
  bodyG.position.y = 0.58;
  root.add(bodyG);

  const body = orb(0.42, M.base, 0.82, 0.8, 1.16);
  body.rotation.x = 0.1;
  bodyG.add(body);
  const chest = orb(0.3, M.light, 0.72, 0.85, 0.66);
  chest.position.set(0, -0.04, 0.3);
  bodyG.add(chest);
  const rump = orb(0.3, M.base, 0.8, 0.72, 0.72);
  rump.position.set(0, 0.14, -0.3);
  bodyG.add(rump);

  // Tail: five fanned feathers, outer pair darker.
  const tailG = new Group();
  tailG.position.set(0, 0.26, -0.44);
  tailG.rotation.x = -0.85;
  bodyG.add(tailG);
  for (let i = -2; i <= 2; i++) {
    const f = orb(0.3, Math.abs(i) === 2 ? M.dark : M.base, 0.14, 1.05, 0.3);
    f.position.set(i * 0.075, 0.26, -Math.abs(i) * 0.02);
    f.rotation.z = i * 0.3;
    f.rotation.x = -Math.abs(i) * 0.1;
    tailG.add(f);
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
    bodyG.add(g);
    return g;
  }
  const wingL = wing(1);
  const wingR = wing(-1);

  // Neck pivot: pecking rotates this.
  const neckG = new Group();
  neckG.position.set(0, 0.3, 0.34);
  bodyG.add(neckG);

  const neck = new Mesh(new CylinderGeometry(0.085, 0.125, 0.34, 12), M.base);
  neck.rotation.x = 0.22;
  neck.position.set(0, 0.1, 0.03);
  neck.castShadow = true;
  neckG.add(neck);
  const head = orb(0.165, M.base, 1, 1.02, 1.05);
  head.position.set(0, 0.3, 0.09);
  neckG.add(head);

  // Comb: four red lobes along the crown.
  const combSizes = [0.045, 0.062, 0.058, 0.042];
  const combLift = [0, 0.02, 0.015, -0.01];
  for (let i = 0; i < 4; i++) {
    const lobe = orb(combSizes[i], combMat, 0.55, 1.25, 0.9);
    lobe.position.set(0, 0.455 + combLift[i], 0.2 - i * 0.075);
    neckG.add(lobe);
  }

  const beakU = new Mesh(new ConeGeometry(0.055, 0.17, 4), legMat);
  beakU.rotation.x = Math.PI / 2;
  beakU.position.set(0, 0.3, 0.335);
  beakU.castShadow = true;
  neckG.add(beakU);
  const beakL = new Mesh(new ConeGeometry(0.038, 0.1, 4), lambert(0xd08b2e));
  beakL.rotation.x = Math.PI / 2;
  beakL.position.set(0, 0.265, 0.3);
  neckG.add(beakL);

  // Wattles under the beak, eyes with a cream ring.
  for (const side of [-1, 1]) {
    const wattle = orb(0.042, combMat, 0.7, 1.5, 0.75);
    wattle.position.set(side * 0.045, 0.185, 0.245);
    neckG.add(wattle);
    const ring = orb(0.04, lambert(0xf6efdf), 1, 1, 0.6);
    ring.position.set(side * 0.135, 0.345, 0.175);
    ring.rotation.y = side * 0.55;
    neckG.add(ring);
    const pupil = orb(0.022, lambert(0x1c1c1c), 1, 1, 0.7);
    pupil.position.set(side * 0.15, 0.345, 0.19);
    pupil.rotation.y = side * 0.55;
    neckG.add(pupil);
  }

  // Legs pivot at the hip; thigh fluff, shin, three toes and a rear spur.
  function leg(side) {
    const g = new Group();
    g.position.set(side * 0.15, 0.44, -0.04);
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
    root.add(g);
    return g;
  }
  const legL = leg(1);
  const legR = leg(-1);

  const s = 0.9 + seedRnd() * 0.25;
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
    new SpriteMaterial({ map: tex, transparent: true }),
  );
  sprite.scale.set(2.3, 0.75, 1);
  sprite.position.y = 2.05;
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

// ── Chicken controller ────────────────────────────────────────────────

let nestSlots = 0;

class Chicken {
  constructor(info) {
    this.cardId = info.card_id;
    this.title = info.title;
    this.project = info.project_name || "";
    this.phase = info.phase;
    this.activitySeen = info.activity;
    this.lastTool = info.last_tool || null;
    this.pecksPlayed = 0;
    this.peckQueue = [];
    this.mode = "emerge";
    this.removed = false;
    this.question = null;
    this.answeredQid = null;
    this.celebrateT = 0;

    this.posV = DOOR_POS.clone();
    this.yaw = 0;
    this.target = null;
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

    const rnd = mulberry32(hashStr(this.cardId));
    if (scene) {
      this.viz = buildChickenMesh(rnd);
      this.viz.root.position.copy(this.posV);
      this.viz.root.userData.cardId = this.cardId;
      this.label = buildLabel(this.title, this.project);
      this.viz.root.add(this.label);
      this.alert = buildAlertIcon();
      this.viz.root.add(this.alert);
      scene.add(this.viz.root);
      this.baseScale = this.viz.root.scale.x;
    } else {
      this.viz = null;
      this.alert = null;
      this.baseScale = 1;
    }
    this.setQuestion(info.question || null);

    this.walkTo(this.randomFieldPoint(rnd), "wander");
    if (info.phase === "testing") this.goNest();
    if (info.phase === "done" || info.phase === "wont_do") this.goHome();
  }

  // question: {id, session_id, data} | null — drives the alert icon. A
  // question the user just answered locally stays suppressed even while the
  // roster still reports it (the resolution lands async host-side).
  setQuestion(q) {
    if (q && this.answeredQid === q.id) q = null;
    this.question = q || null;
    if (this.alert) this.alert.visible = !!this.question;
  }

  randomFieldPoint(rnd) {
    const r = rnd || Math;
    const rx = r.random ? r.random() : r();
    const rz = r.random ? r.random() : r();
    return new Vector3(
      FIELD.minX + rx * (FIELD.maxX - FIELD.minX),
      0,
      FIELD.minZ + rz * (FIELD.maxZ - FIELD.minZ),
    );
  }

  walkTo(v, afterMode) {
    this.target = v.clone();
    this.afterWalk = afterMode;
    if (this.mode !== "emerge") this.mode = "walk";
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
      this.walkTo(this.randomFieldPoint(), "wander");
    }
  }

  goNest() {
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
    this.walkTo(this.nestPos, "nest");
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
    this.peckQueue.length = 0;
    this.peckPlan = null;
    this.walkTo(DOOR_POS, "homeArrive");
  }

  // Roster no longer contains this card at all: same exit as done.
  setGone() {
    if (this.mode === "homeArrive" || this.mode === "gone") return;
    this.goHome();
  }

  noteActivity(activity, toolClass) {
    if (activity > this.activitySeen) {
      const delta = Math.min(activity - this.activitySeen, MAX_QUEUED_PECKS);
      for (let i = 0; i < delta; i++) {
        if (this.peckQueue.length < MAX_QUEUED_PECKS)
          this.peckQueue.push(toolClass || "other");
      }
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
    this.pecksPlayed++;
  }

  update(dt) {
    const viz = this.viz;

    // Movement for walking modes.
    const moving =
      (this.mode === "walk" || this.mode === "emerge") && this.target;
    if (moving) {
      const speed = this.afterWalk === "homeArrive" ? HOME_SPEED : WALK_SPEED;
      const to = this.target.clone().sub(this.posV);
      to.y = 0;
      const dist = to.length();
      if (dist < 0.12) {
        this.mode =
          this.afterWalk === "homeArrive" ? "homeArrive" : this.afterWalk;
        this.target = null;
        this.pauseUntil = performance.now() / 1000 + 1 + Math.random() * 2.2;
        if (this.mode === "nest") this.sitDown();
        if (this.mode === "homeArrive") this.fadeT = 0;
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

    // Idle wandering: alternate pause / new waypoint, and play queued pecks.
    if (this.mode === "wander") {
      if (this.peckQueue.length > 0) {
        this.startPeck(this.peckQueue.shift());
      } else if (performance.now() / 1000 > this.pauseUntil) {
        this.walkTo(this.randomFieldPoint(), "wander");
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
      } else if (this.mode === "wander") {
        viz.legL.rotation.x = 0;
        viz.legR.rotation.x = 0;
        viz.root.position.y = 0;
        viz.neckG.rotation.x = Math.sin(performance.now() / 700) * 0.06;
        viz.wingL.rotation.z = 0;
        viz.wingR.rotation.z = 0;
      }
    }

    // Alert icon: bob + gentle pulse while a question is pending; a short
    // celebratory double-flap right after the user answers.
    if (this.alert && this.alert.visible) {
      const tSec = performance.now() / 1000;
      this.alert.position.y = 2.55 + Math.sin(tSec * 3.1) * 0.09;
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

  sitDown() {
    if (!this.viz) return;
    this.viz.legL.visible = false;
    this.viz.legR.visible = false;
    this.posV.y = -0.18; // sunk into the nest; the frame loop applies posV
    this.viz.neckG.rotation.x = 0;
  }

  dispose() {
    this.removed = true;
    this.leaveNest();
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
  const chickens = [
    {
      card_id: "demo-worker",
      project_name: "demo",
      title: "Implement egg module",
      step: "in_progress",
      phase: "working",
      activity: Math.floor(t / 3),
      tool_class: ["command", "edit", "read", "other"][Math.floor(t / 3) % 4],
      last_tool: "Bash",
      blocked: false,
      busy: true,
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
                projectName: "demo",
              },
            }
          : null,
    },
    {
      card_id: "demo-tester",
      project_name: "demo",
      title: "Review coop door",
      step: "review",
      phase: "testing",
      activity: 0,
      tool_class: null,
      last_tool: null,
      blocked: false,
      busy: true,
    },
  ];
  const cycle = t % 30;
  if (cycle < 22) {
    chickens.push({
      card_id: "demo-cycler",
      project_name: "demo",
      title: cycle < 14 ? "Wander the run" : "Head home",
      step: cycle < 14 ? "in_progress" : "done",
      phase: cycle < 14 ? "working" : "done",
      activity: Math.floor(Math.min(cycle, 14) / 2),
      tool_class: "command",
      last_tool: "Bash",
      blocked: false,
      busy: true,
    });
  }
  return { chickens };
}

// ── Reconciler + mirror ───────────────────────────────────────────────

const flock = {}; // card_id → Chicken
const mirrorEl = document.getElementById("coop-mirror");
const hudEl = document.getElementById("hud");
const emptyEl = document.getElementById("empty");
let lastError = null;

function reconcile(state) {
  const seen = {};
  for (const info of state.chickens || []) {
    seen[info.card_id] = true;
    let c = flock[info.card_id];
    if (!c) {
      c = new Chicken(info);
      flock[info.card_id] = c;
    } else {
      c.title = info.title;
      c.setPhase(info.phase);
      c.noteActivity(info.activity, info.tool_class);
      c.lastTool = info.last_tool || c.lastTool;
      c.setQuestion(info.question || null);
    }
  }
  for (const id of Object.keys(flock)) {
    if (!seen[id]) flock[id].setGone();
  }
  syncMirror();
}

function syncMirror() {
  const rows = [];
  let working = 0;
  let testing = 0;
  let questions = 0;
  for (const id of Object.keys(flock)) {
    const c = flock[id];
    if (c.mode === "gone") {
      const el = mirrorEl.querySelector('[data-card-id="' + id + '"]');
      if (el) el.remove();
      delete flock[id];
      continue;
    }
    if (c.phase === "working") working++;
    if (c.phase === "testing") testing++;
    if (c.question) questions++;
    let el = mirrorEl.querySelector('[data-card-id="' + id + '"]');
    if (!el) {
      el = document.createElement("div");
      el.setAttribute("data-testid", "coop-chicken");
      el.setAttribute("data-card-id", id);
      mirrorEl.appendChild(el);
    }
    el.setAttribute("data-phase", c.phase);
    el.setAttribute("data-anim", c.mode);
    el.setAttribute("data-activity", String(c.activitySeen));
    el.setAttribute("data-pecks", String(c.pecksPlayed));
    el.setAttribute("data-title", c.title);
    el.setAttribute("data-question", c.question ? c.question.id : "");
    rows.push({
      cardId: id,
      title: c.title,
      phase: c.phase,
      anim: c.mode,
      activity: c.activitySeen,
      pecks: c.pecksPlayed,
      question: c.question ? c.question.id : null,
    });
  }
  window.__coopState = rows;
  const total = rows.length;
  hudEl.textContent =
    (renderer ? "" : "(no WebGL — roster only) ") +
    (lastError ? "reconnecting… " : "") +
    total +
    " hen" +
    (total === 1 ? "" : "s") +
    " out · " +
    working +
    " working · " +
    testing +
    " testing" +
    (questions > 0
      ? " · " + questions + " question" + (questions === 1 ? "" : "s")
      : "");
  emptyEl.style.display = total === 0 ? "flex" : "none";
}

// Test/demo hooks: force a peck, inspect or open a hen's pending question.
window.__coopTest = {
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
  renderer.domElement.addEventListener("pointerdown", (ev) => {
    const c = pick(ev);
    if (c && c.question) openQuestionModal(c);
  });
  let hoverAt = 0;
  renderer.domElement.addEventListener("pointermove", (ev) => {
    const now = performance.now();
    if (now - hoverAt < 60) return;
    hoverAt = now;
    const c = pick(ev);
    renderer.domElement.style.cursor = c && c.question ? "pointer" : "default";
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
    escapeHtml(PHASE_BLURB[chicken.phase] || chicken.phase) +
    " · " +
    escapeHtml(activityLine) +
    "</div>" +
    pipelineSvg(chicken.phase) +
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
// ── Poll + main loop ──────────────────────────────────────────────────

let demoClock = 0;

async function poll() {
  try {
    if (DEMO) {
      reconcile(demoState(demoClock));
      // Auto-open the modal once in the standalone demo so the Q&A flow is
      // visible without hunting for the hen.
      const dw = flock["demo-worker"];
      if (!window.__demoQuestionOpened && dw && dw.question) {
        window.__demoQuestionOpened = true;
        openQuestionModal(dw);
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
    setTimeout(poll, POLL_MS);
  }
}

let lastT = performance.now();

function animate() {
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
  if (renderer) renderer.render(scene, camera);
}

initScene();
initPicking();
syncMirror();
poll();
animate();
