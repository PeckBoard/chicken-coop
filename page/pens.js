// Project pens — pure math (no three.js, no DOM) so vitest can cover it
// directly (test/pens.test.ts). The page decides WHEN to re-layout (only
// when the project key-set changes, so pens never jump between polls);
// these functions are deterministic in their inputs.
//
// Geometry: the pennable area splits into one fenced column per project,
// side by side along x, each with a gate in its south fence (the camera
// side). The strip south of the pens is the shared commons — project-less
// session birds live there, and everyone else uses it as the travel lane
// between their gate and the coop / nests / outer fence.

export const COMMONS_DEPTH = 2.2; // z-depth of the shared commons strip
export const GATE_W = 1.2; // gap in each pen's south fence
export const MIN_PEN_W = 2.6; // a quiet project still gets room to wander
const GATE_APPROACH = 0.55; // waypoint just inside the gate line

/// Split `field` into pens plus the commons strip. entries: [{key, count}],
/// key = project name; counts only shape widths (busier projects get wider
/// pens) — order and position come from the sorted keys alone. Fewer than
/// two projects: no pens, the whole field is commons (the open-run look).
export function penLayout(entries, field) {
  const width = field.maxX - field.minX;
  const commons = {
    minX: field.minX,
    maxX: field.maxX,
    minZ: field.maxZ - COMMONS_DEPTH,
    maxZ: field.maxZ,
  };
  const corridorZ = commons.minZ + Math.min(0.8, COMMONS_DEPTH / 2);
  const projects = entries
    .filter((e) => e.key)
    .slice()
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  if (projects.length < 2) {
    return { pens: [], commons: { ...field }, corridorZ };
  }
  let widths;
  if (MIN_PEN_W * projects.length >= width) {
    widths = projects.map(() => width / projects.length);
  } else {
    const weights = projects.map((e) => 1 + Math.max(0, e.count | 0));
    const wsum = weights.reduce((a, b) => a + b, 0);
    widths = weights.map((w) => (width * w) / wsum);
    // Lift narrow pens to the floor; shrink the wide ones to pay for it.
    let need = 0;
    let flex = 0;
    widths = widths.map((w) => {
      if (w < MIN_PEN_W) {
        need += MIN_PEN_W - w;
        return MIN_PEN_W;
      }
      flex += w - MIN_PEN_W;
      return w;
    });
    if (need > 0 && flex > 0) {
      const k = (flex - need) / flex;
      widths = widths.map((w) =>
        w > MIN_PEN_W ? MIN_PEN_W + (w - MIN_PEN_W) * k : w,
      );
    }
  }
  let x = field.minX;
  const maxZ = commons.minZ;
  const pens = projects.map((e, i) => {
    const rect = { minX: x, maxX: x + widths[i], minZ: field.minZ, maxZ };
    x = rect.maxX;
    return {
      key: e.key,
      rect,
      gate: { x: (rect.minX + rect.maxX) / 2, z: maxZ },
    };
  });
  pens[pens.length - 1].rect.maxX = field.maxX; // absorb float drift
  return { pens, commons, corridorZ };
}

export function rectContains(rect, p, inset = 0) {
  return (
    p.x >= rect.minX + inset &&
    p.x <= rect.maxX - inset &&
    p.z >= rect.minZ + inset &&
    p.z <= rect.maxZ - inset
  );
}

// Segment-vs-AABB slab test on the ground plane.
function segmentHitsRect(a, b, rect) {
  let t0 = 0;
  let t1 = 1;
  const d = { x: b.x - a.x, z: b.z - a.z };
  for (const [p0, dir, lo, hi] of [
    [a.x, d.x, rect.minX, rect.maxX],
    [a.z, d.z, rect.minZ, rect.maxZ],
  ]) {
    if (Math.abs(dir) < 1e-9) {
      if (p0 < lo || p0 > hi) return false;
      continue;
    }
    let near = (lo - p0) / dir;
    let far = (hi - p0) / dir;
    if (near > far) [near, far] = [far, near];
    t0 = Math.max(t0, near);
    t1 = Math.min(t1, far);
    if (t0 > t1) return false;
  }
  return true;
}

/// Waypoints from `a` to `b` (both {x,z}) that respect the fences: leave
/// and enter pens only through their gate, travel along the commons
/// corridor between gates. Returns the points to walk in order, ending
/// with `b` (`a` excluded). No pens: just the straight line.
export function penRoute(a, b, layout) {
  const pens = layout.pens;
  if (!pens.length) return [b];
  const from = pens.find((p) => rectContains(p.rect, a));
  const to = pens.find((p) => rectContains(p.rect, b));
  if (from === to) return [b];
  const block = {
    minX: pens[0].rect.minX,
    maxX: pens[pens.length - 1].rect.maxX,
    minZ: pens[0].rect.minZ,
    maxZ: pens[0].rect.maxZ,
  };
  if (!from && !to && !segmentHitsRect(a, b, block)) return [b];
  const cz = layout.corridorZ;
  const pts = [];
  if (from) {
    pts.push({ x: from.gate.x, z: from.gate.z - GATE_APPROACH });
    pts.push({ x: from.gate.x, z: cz });
  } else if (a.z < block.maxZ) {
    // West or east of the pen block: drop straight into the corridor.
    pts.push({ x: a.x, z: cz });
  }
  if (to) {
    pts.push({ x: to.gate.x, z: cz });
    pts.push({ x: to.gate.x, z: to.gate.z - GATE_APPROACH });
  } else if (b.z < block.maxZ) {
    pts.push({ x: b.x, z: cz });
  }
  pts.push(b);
  return pts;
}
