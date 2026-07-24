// Pure helpers for the hidden-tab throttling. Kept out of main.js (which
// builds DOM and a WebGL context on import) so vitest can exercise them;
// main.js imports these.

// State-poll delay by tab visibility. Visible → the normal cadence; hidden
// → null, meaning "don't reschedule" so a backgrounded tab does zero polling
// (no fetch, no network). main.js fires one fresh poll the moment the tab is
// shown again, so pausing loses no correctness.
export function pollDelay(hidden, base) {
  return hidden ? null : base;
}

// How many pecks to enqueue for an activity jump from `prev` to `next`,
// given the queue already holds `queued`, capped at `cap`. The cap is what
// stops a long hidden gap from replaying minutes of clucks: however far
// `next` outran `prev`, a bird catches up with at most `cap` pecks total.
export function pecksToQueue(prev, next, queued, cap) {
  if (next <= prev) return 0;
  const want = Math.min(next - prev, cap);
  return Math.max(0, Math.min(want, cap - queued));
}
