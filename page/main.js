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
// Everything is procedural three.js primitives — no external assets.

import {
  AmbientLight,
  BoxGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  MathUtils,
  Mesh,
  MeshLambertMaterial,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  TorusGeometry,
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

function box(w, h, d, color) {
  const m = new Mesh(new BoxGeometry(w, h, d), lambert(color));
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

// ── World: ground, coop, fence, nests, greenery ───────────────────────

function buildWorld() {
  const ground = new Mesh(new PlaneGeometry(70, 46), lambert(0x79a659));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Coop: body, pyramid roof, dark doorway, ramp.
  const coop = new Group();
  const body = box(3.4, 2.6, 3.4, 0xa4653a);
  body.position.y = 1.3;
  coop.add(body);
  const roof = new Mesh(new ConeGeometry(2.9, 1.7, 4), lambert(0x7c3f24));
  roof.position.y = 3.45;
  roof.rotation.y = Math.PI / 4;
  roof.castShadow = true;
  coop.add(roof);
  const door = box(0.04, 1.15, 0.9, 0x2a1c12);
  door.position.set(1.71, 0.62, 1.0);
  coop.add(door);
  const ramp = box(1.6, 0.06, 0.8, 0x8f6b4a);
  ramp.position.set(2.45, 0.28, 1.0);
  ramp.rotation.z = -0.32;
  coop.add(ramp);
  coop.position.copy(COOP_POS);
  scene.add(coop);

  // Fence along the back and right.
  const postG = new CylinderGeometry(0.07, 0.08, 1.1, 6);
  const postM = lambert(0x9b8262);
  for (let x = -11.5; x <= 11.5; x += 2.6) {
    const p = new Mesh(postG, postM);
    p.position.set(x, 0.55, -7.2);
    p.castShadow = true;
    scene.add(p);
  }
  const railB = box(23.5, 0.09, 0.06, 0x9b8262);
  railB.position.set(0, 0.85, -7.2);
  scene.add(railB);
  const railB2 = railB.clone();
  railB2.position.y = 0.45;
  scene.add(railB2);

  // Grass tufts + tiny flowers, deterministic scatter.
  const rnd = mulberry32(20260723);
  const tuftG = new ConeGeometry(0.09, 0.34, 5);
  const tuftM = lambert(0x5e8f3e);
  for (let i = 0; i < 90; i++) {
    const t = new Mesh(tuftG, tuftM);
    t.position.set(-12 + rnd() * 24, 0.16, -6.8 + rnd() * 13);
    t.rotation.y = rnd() * Math.PI;
    scene.add(t);
  }
  const petalM = [lambert(0xe86a6a), lambert(0xf0d75e), lambert(0xffffff)];
  const petalG = new SphereGeometry(0.09, 6, 5);
  const stemG = new CylinderGeometry(0.02, 0.02, 0.3, 5);
  const stemM = lambert(0x4d7a33);
  for (let i = 0; i < 22; i++) {
    const f = new Group();
    const stem = new Mesh(stemG, stemM);
    stem.position.y = 0.15;
    f.add(stem);
    const head = new Mesh(petalG, petalM[i % 3]);
    head.position.y = 0.34;
    f.add(head);
    f.position.set(-11.5 + rnd() * 23, 0, -6.6 + rnd() * 12.6);
    scene.add(f);
  }
}

// One straw nest (with egg) per testing chicken, created on demand.
function buildNest() {
  const g = new Group();
  const ring = new Mesh(new TorusGeometry(0.5, 0.17, 7, 14), lambert(0xc9a24a));
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.14;
  ring.castShadow = true;
  ring.receiveShadow = true;
  g.add(ring);
  const egg = new Mesh(new SphereGeometry(0.17, 10, 8), lambert(0xfdf6e3));
  egg.scale.y = 1.25;
  egg.position.y = 0.2;
  egg.castShadow = true;
  g.add(egg);
  return g;
}

// ── Chicken model ─────────────────────────────────────────────────────

function buildChickenMesh(seedRnd) {
  const plumage = PLUMAGE[Math.floor(seedRnd() * PLUMAGE.length)];
  const root = new Group();

  const bodyG = new Group();
  bodyG.position.y = 0.58;
  root.add(bodyG);

  const body = box(0.62, 0.52, 0.88, plumage);
  bodyG.add(body);

  // Tail: three fanned feathers.
  for (let i = -1; i <= 1; i++) {
    const f = box(0.1, 0.34, 0.12, plumage);
    f.position.set(i * 0.13, 0.28, -0.48);
    f.rotation.x = -0.7 - Math.abs(i) * 0.12;
    f.rotation.z = i * 0.22;
    bodyG.add(f);
  }

  // Wings pivot at their top edge so rotation.z lifts them outward.
  function wing(side) {
    const g = new Group();
    g.position.set(side * 0.33, 0.2, 0);
    const w = box(0.07, 0.3, 0.56, plumage);
    w.position.y = -0.15;
    g.add(w);
    bodyG.add(g);
    return g;
  }
  const wingL = wing(1);
  const wingR = wing(-1);

  // Neck pivot: pecking rotates this.
  const neckG = new Group();
  neckG.position.set(0, 0.3, 0.34);
  bodyG.add(neckG);

  const head = box(0.32, 0.34, 0.32, plumage);
  head.position.set(0, 0.22, 0.06);
  neckG.add(head);

  const combM = lambert(0xd8402a);
  for (let i = 0; i < 3; i++) {
    const c = new Mesh(new BoxGeometry(0.07, 0.11 - i * 0.02, 0.1), combM);
    c.position.set(0, 0.44, 0.14 - i * 0.11);
    neckG.add(c);
  }
  const beak = new Mesh(new ConeGeometry(0.07, 0.2, 4), lambert(0xe8a33d));
  beak.rotation.x = Math.PI / 2;
  beak.position.set(0, 0.2, 0.32);
  neckG.add(beak);
  const wattle = new Mesh(new BoxGeometry(0.07, 0.12, 0.07), combM);
  wattle.position.set(0, 0.08, 0.26);
  neckG.add(wattle);
  const eyeG = new BoxGeometry(0.04, 0.04, 0.04);
  const eyeM = new MeshLambertMaterial({ color: 0x1c1c1c });
  for (const side of [-1, 1]) {
    const e = new Mesh(eyeG, eyeM);
    e.position.set(side * 0.17, 0.26, 0.16);
    neckG.add(e);
  }

  // Legs pivot at the hip.
  function leg(side) {
    const g = new Group();
    g.position.set(side * 0.15, 0.44, -0.04);
    const shin = new Mesh(new CylinderGeometry(0.032, 0.032, 0.44, 6), lambert(0xe8a33d));
    shin.position.y = -0.22;
    shin.castShadow = true;
    g.add(shin);
    const foot = box(0.14, 0.05, 0.2, 0xe8a33d);
    foot.position.set(0, -0.44, 0.05);
    g.add(foot);
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
  const sprite = new Sprite(new SpriteMaterial({ map: tex, transparent: true }));
  sprite.scale.set(2.3, 0.75, 1);
  sprite.position.y = 2.05;
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
    p.position.set((Math.random() - 0.5) * 0.3, 0.05, (Math.random() - 0.5) * 0.3);
    p.userData.vel = new Vector3((Math.random() - 0.5) * 1.2, 0.9 + Math.random(), (Math.random() - 0.5) * 1.2);
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
    this.pecksPlayed = 0;
    this.peckQueue = [];
    this.mode = "emerge";
    this.removed = false;

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
      this.label = buildLabel(this.title, this.project);
      this.viz.root.add(this.label);
      scene.add(this.viz.root);
      this.baseScale = this.viz.root.scale.x;
    } else {
      this.viz = null;
      this.baseScale = 1;
    }

    this.walkTo(this.randomFieldPoint(rnd), "wander");
    if (info.phase === "testing") this.goNest();
    if (info.phase === "done" || info.phase === "wont_do") this.goHome();
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
    else if (phase === "working" && (prev === "testing" || prev === "done" || prev === "wont_do")) {
      this.leaveNest();
      this.walkTo(this.randomFieldPoint(), "wander");
    }
  }

  goNest() {
    if (!this.nestPos) {
      const slot = nestSlots++;
      this.nestPos = new Vector3(NEST_BASE.x, 0, NEST_BASE.z + (slot % 6) * NEST_GAP);
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
        if (this.peckQueue.length < MAX_QUEUED_PECKS) this.peckQueue.push(toolClass || "other");
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
    const moving = (this.mode === "walk" || this.mode === "emerge") && this.target;
    if (moving) {
      const speed = this.afterWalk === "homeArrive" ? HOME_SPEED : WALK_SPEED;
      const to = this.target.clone().sub(this.posV);
      to.y = 0;
      const dist = to.length();
      if (dist < 0.12) {
        this.mode = this.afterWalk === "homeArrive" ? "homeArrive" : this.afterWalk;
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
          spawnPuff(this.posV.clone().add(new Vector3(Math.sin(this.yaw) * 0.6, 0, Math.cos(this.yaw) * 0.6)));
          this.peckPlan.dust = false;
        }
      }
    }

    // Nesting: settled on the egg, occasional wing flap.
    if (this.mode === "nest" && viz) {
      this.flapAt -= dt;
      if (this.flapAt <= 0) this.flapAt = 4 + Math.random() * 3;
      const flap = this.flapAt > 0.6 ? 0 : Math.sin((0.6 - this.flapAt) * 18) * 1.1;
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

function apiFetch(path) {
  return new Promise((resolve, reject) => {
    const requestId = ++reqSeq;
    pending[requestId] = { resolve, reject };
    window.parent.postMessage({ type: "plugin-ui-fetch", requestId, method: "GET", path }, "*");
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
  if (!m || m.type !== "plugin-ui-fetch-result" || !pending[m.requestId]) return;
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
      blocked: false,
      busy: true,
    },
    {
      card_id: "demo-tester",
      project_name: "demo",
      title: "Review coop door",
      step: "review",
      phase: "testing",
      activity: 0,
      tool_class: null,
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
    rows.push({
      cardId: id,
      title: c.title,
      phase: c.phase,
      anim: c.mode,
      activity: c.activitySeen,
      pecks: c.pecksPlayed,
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
    " testing";
  emptyEl.style.display = total === 0 ? "flex" : "none";
}

// Test/demo hook: force a peck without waiting for real activity deltas.
window.__coopTest = {
  peck(cardId, cls) {
    const c = flock[cardId];
    if (c) c.peckQueue.push(cls || "command");
    return !!c;
  },
};

// ── Poll + main loop ──────────────────────────────────────────────────

let demoClock = 0;

async function poll() {
  try {
    if (DEMO) {
      reconcile(demoState(demoClock));
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
syncMirror();
poll();
animate();
