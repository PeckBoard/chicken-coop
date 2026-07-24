import { describe, expect, it } from "vitest";
import {
  COMMONS_DEPTH,
  GATE_W,
  MIN_PEN_W,
  penLayout,
  penRoute,
  rectContains,
} from "../page/pens.js";

const FIELD = { minX: -6, maxX: 6.4, minZ: -5.5, maxZ: 5.5 };

function entries(...pairs: Array<[string, number]>) {
  return pairs.map(([key, count]) => ({ key, count }));
}

describe("penLayout", () => {
  it("keeps the whole field open for zero or one project", () => {
    for (const e of [
      entries(),
      entries(["solo", 4]),
      entries(["", 3], ["solo", 1]), // commons key never makes a pen
    ]) {
      const l = penLayout(e, FIELD);
      expect(l.pens).toEqual([]);
      expect(l.commons).toEqual(FIELD);
    }
  });

  it("splits the field into one pen per project, sorted by key", () => {
    const l = penLayout(entries(["zeta", 1], ["alpha", 2], ["mid", 1]), FIELD);
    expect(l.pens.map((p) => p.key)).toEqual(["alpha", "mid", "zeta"]);
    // Contiguous tiling of the full width, commons strip carved off south.
    expect(l.pens[0].rect.minX).toBe(FIELD.minX);
    expect(l.pens[2].rect.maxX).toBe(FIELD.maxX);
    expect(l.pens[1].rect.minX).toBeCloseTo(l.pens[0].rect.maxX);
    expect(l.pens[2].rect.minX).toBeCloseTo(l.pens[1].rect.maxX);
    for (const p of l.pens) {
      expect(p.rect.minZ).toBe(FIELD.minZ);
      expect(p.rect.maxZ).toBeCloseTo(FIELD.maxZ - COMMONS_DEPTH);
    }
    expect(l.commons.minZ).toBeCloseTo(FIELD.maxZ - COMMONS_DEPTH);
    expect(l.commons.maxZ).toBe(FIELD.maxZ);
  });

  it("gives busier projects wider pens but respects the floor", () => {
    const l = penLayout(entries(["busy", 9], ["quiet", 0]), FIELD);
    const w = (p: { rect: { minX: number; maxX: number } }) =>
      p.rect.maxX - p.rect.minX;
    const busy = l.pens.find((p) => p.key === "busy")!;
    const quiet = l.pens.find((p) => p.key === "quiet")!;
    expect(w(busy)).toBeGreaterThan(w(quiet));
    expect(w(quiet)).toBeGreaterThanOrEqual(MIN_PEN_W - 1e-9);
    expect(w(busy) + w(quiet)).toBeCloseTo(FIELD.maxX - FIELD.minX);
  });

  it("is deterministic and order-independent", () => {
    const a = penLayout(entries(["a", 2], ["b", 5]), FIELD);
    const b = penLayout(entries(["b", 5], ["a", 2]), FIELD);
    expect(a).toEqual(b);
  });

  it("puts each gate on its pen's south fence, inside the pen span", () => {
    const l = penLayout(entries(["a", 1], ["b", 3], ["c", 2]), FIELD);
    for (const p of l.pens) {
      expect(p.gate.z).toBe(p.rect.maxZ);
      expect(p.gate.x - GATE_W / 2).toBeGreaterThan(p.rect.minX);
      expect(p.gate.x + GATE_W / 2).toBeLessThan(p.rect.maxX);
    }
  });

  it("falls back to equal widths when the floor cannot fit", () => {
    const many = entries(...("abcdefgh".split("").map((k) => [k, 1]) as any));
    const l = penLayout(many, FIELD);
    const widths = l.pens.map((p) => p.rect.maxX - p.rect.minX);
    for (const w of widths) expect(w).toBeCloseTo(widths[0]);
  });
});

describe("penRoute", () => {
  const layout = penLayout(entries(["a", 1], ["b", 1]), FIELD);
  const [penA, penB] = layout.pens;
  const mid = (r: {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
  }) => ({ x: (r.minX + r.maxX) / 2, z: (r.minZ + r.maxZ) / 2 });

  it("goes straight when no pens exist", () => {
    const open = penLayout(entries(["solo", 1]), FIELD);
    expect(penRoute({ x: -7, z: 0 }, { x: 5, z: -3 }, open)).toEqual([
      { x: 5, z: -3 },
    ]);
  });

  it("goes straight inside one pen", () => {
    const a = { x: penA.rect.minX + 1, z: -2 };
    const b = { x: penA.gate.x, z: -4 };
    expect(penRoute(a, b, layout)).toEqual([b]);
  });

  it("exits and enters through the gates between two pens", () => {
    const pts = penRoute(mid(penA.rect), mid(penB.rect), layout);
    // Own gate out, corridor leg, target gate in, then the target.
    expect(pts.length).toBe(5);
    expect(pts[0].x).toBeCloseTo(penA.gate.x);
    expect(pts[1]).toEqual({ x: penA.gate.x, z: layout.corridorZ });
    expect(pts[2]).toEqual({ x: penB.gate.x, z: layout.corridorZ });
    expect(pts[3].x).toBeCloseTo(penB.gate.x);
    expect(pts[4]).toEqual(mid(penB.rect));
    // No leg ever crosses the other pen's interior: every intermediate
    // point sits on a gate x or in the corridor.
    for (const p of pts.slice(0, 4)) {
      expect(
        p.z >= layout.corridorZ - 1e9 ||
          p.z >= layout.corridorZ - 1e-9 ||
          p.x === penB.gate.x,
      ).toBe(true);
    }
  });

  it("routes door -> pen via the corridor", () => {
    const door = { x: -7.8, z: -1.2 }; // west of the field, outside pens
    const pts = penRoute(door, mid(penB.rect), layout);
    expect(pts[0]).toEqual({ x: door.x, z: layout.corridorZ });
    expect(pts[1]).toEqual({ x: penB.gate.x, z: layout.corridorZ });
    expect(pts[pts.length - 1]).toEqual(mid(penB.rect));
  });

  it("routes pen -> nest (east, outside) via gate and east lane", () => {
    const nest = { x: 9, z: -4.6 };
    const pts = penRoute(mid(penA.rect), nest, layout);
    expect(pts[1]).toEqual({ x: penA.gate.x, z: layout.corridorZ });
    // Drops into the corridor at the nest's x before turning north.
    expect(pts[pts.length - 2]).toEqual({ x: nest.x, z: layout.corridorZ });
    expect(pts[pts.length - 1]).toEqual(nest);
  });

  it("goes straight between outside points that never cross the pens", () => {
    const a = { x: 9, z: -4.6 }; // by the nests
    const b = { x: 10.85, z: 2 }; // outer fence
    expect(penRoute(a, b, layout)).toEqual([b]);
  });

  it("commons birds walk the commons directly", () => {
    const a = { x: -4, z: FIELD.maxZ - 0.5 };
    const b = { x: 4, z: FIELD.maxZ - 0.3 };
    expect(penRoute(a, b, layout)).toEqual([b]);
  });
});

describe("rectContains", () => {
  it("respects the inset", () => {
    const r = { minX: 0, maxX: 4, minZ: 0, maxZ: 4 };
    expect(rectContains(r, { x: 0.2, z: 2 })).toBe(true);
    expect(rectContains(r, { x: 0.2, z: 2 }, 0.5)).toBe(false);
    expect(rectContains(r, { x: 5, z: 2 })).toBe(false);
  });
});
