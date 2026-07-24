import { describe, expect, it } from "vitest";
import { pecksToQueue, pollDelay } from "../page/visibility.js";

describe("pollDelay", () => {
  it("keeps the normal cadence while visible", () => {
    expect(pollDelay(false, 1000)).toBe(1000);
  });

  it("parks polling (null) while hidden", () => {
    expect(pollDelay(true, 1000)).toBeNull();
  });
});

describe("pecksToQueue", () => {
  const CAP = 3;

  it("queues nothing when activity did not advance", () => {
    expect(pecksToQueue(5, 5, 0, CAP)).toBe(0);
    expect(pecksToQueue(5, 4, 0, CAP)).toBe(0);
  });

  it("queues one per single-step advance", () => {
    expect(pecksToQueue(0, 1, 0, CAP)).toBe(1);
    expect(pecksToQueue(4, 5, 0, CAP)).toBe(1);
  });

  it("caps a long hidden gap at the max, never a minutes-long replay", () => {
    // Thousands of pecks accrued while hidden still catch up with at most CAP.
    expect(pecksToQueue(0, 9999, 0, CAP)).toBe(3);
    expect(pecksToQueue(10, 400, 0, CAP)).toBe(3);
  });

  it("respects pecks already queued so the queue never exceeds the cap", () => {
    expect(pecksToQueue(0, 9999, 2, CAP)).toBe(1);
    expect(pecksToQueue(0, 9999, 3, CAP)).toBe(0);
    expect(pecksToQueue(0, 9999, 5, CAP)).toBe(0); // clamps, never negative
  });
});
