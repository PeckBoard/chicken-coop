# Chicken Coop

A PeckBoard plugin that turns the board's work-in-progress into a 3D chicken
run: one low-poly hen per card being worked on. A hen leaves the coop when its
card starts, wanders the run and pecks at the grass as its worker runs
commands and edits files, sits on a nest while the card is in a testing step
(e.g. `review`), and walks back into the coop — and disappears — when the card
lands on `done` / `wont_do`.

## How It Works

- **Page** (`GET /plugin-api/v1/chicken-coop`, sidebar item "Chicken Coop"):
  a self-contained three.js scene compiled into the wasm. Runs in the app's
  sandboxed plugin iframe; opened standalone it renders a demo roster.
- **State** (`GET /api/plugin-ui/chicken-coop/state`, authed): polled once a
  second through the parent fetch bridge. The plugin derives it live:
  - roster: `peckboard_list_cards` — every card whose step is neither
    backlog/todo nor terminal gets a hen (`in_progress` → working, any other
    non-terminal step → testing). Done/wont-do cards linger for 2 minutes so
    the walk-home animation can play.
  - activity: `peckboard_session_events` (slim event tail, `session_read`)
    on each card's worker session; `agent-tool-start` events increment a
    per-card counter, classified into peck styles (command / edit / read /
    other). The page pecks on observed deltas.

Because activity comes from the event log (not `mcp.tool.call.*` hooks), it
works identically for real providers and the deterministic `mock:*` providers
used by Playwright e2e.

Requires a PeckBoard with the `peckboard_session_events` host function.

## Development

```sh
./build.sh              # npm install (first run) + two-stage bundle + extism-js
npm test                # vitest for the state derivation
```

The build is two-stage: `page/main.js` (+ three.js) is bundled/minified first
and embedded as a JSON-escaped string in `src/generated/pageBundle.ts`, then
the plugin itself is bundled CJS/es2020 and compiled by `extism-js` to
`dist/plugin.wasm`.

Install locally by copying `dist/plugin.wasm` to `<data-dir>/plugins/chicken-coop.wasm`,
restarting PeckBoard, and approving the plugin in Settings → Plugins.

## e2e

`peckboard/web/e2e/tests/chicken-coop.spec.ts` stages the wasm into the test
data dir (see `playwright.config.ts`), approves it, and drives a card through
backlog → in_progress → review → done with mock workers, asserting the hen's
phases, activity counter, and despawn via the page's DOM mirror
(`[data-testid=coop-chicken]`).

## Registry Entry Template

```json
{
  "id": "chicken-coop",
  "name": "Chicken Coop",
  "description": "3D chicken run visualizing cards being worked on — one hen per active card.",
  "author": "PeckBoard",
  "sha256": "030b0cc79ed9429c39c964085ea847d00493b328d1bd3a004f3b6633f0d6044a",
  "min_peckboard": "0.0.130"
  "tags": ["visualization", "fun", "workers"],
  "category": "visualization",
  "hooks": ["http.request.before", "http.request.authed"],
  "url": "https://github.com/PeckBoard/chicken-coop/releases/download/v0.1.0/chicken-coop.wasm",
  "sha256": "<sha256 of the released asset>",
  "min_peckboard": "<first core version with peckboard_session_events>"
}
```
