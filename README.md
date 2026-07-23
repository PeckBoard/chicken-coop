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
  - questions: `peckboard_session_questions` (`worker_questions`) surfaces a
    worker's unresolved `ask_user` question. The hen gets a bobbing "!" badge;
    clicking her opens a Q&A modal with the question, its options, and enough
    context to answer (card title/description, project, a workflow-position
    diagram, recent tool activity).
- **Answer** (`POST /api/plugin-ui/chicken-coop/answer`, authed): body
  `{session_id, question_id, answers, rejected}`. Validated in the wasm, then
  resolved via `peckboard_answer_question`, which runs core's own
  question-resolution flow (event + broadcast + conversation resume) under
  the user's authority.

Because activity comes from the event log (not `mcp.tool.call.*` hooks), it
works identically for real providers and the deterministic `mock:*` providers
used by Playwright e2e.

Requires a PeckBoard with the `peckboard_session_events` host function; the
question alert/answer flow additionally needs `peckboard_session_questions` /
`peckboard_answer_question` (and the `worker_questions` permission grant).

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
  "homepage": "https://github.com/PeckBoard/chicken-coop",
  "version": "0.2.0",
  "tags": ["visualization", "fun", "workers"],
  "category": "visualization",
  "hooks": ["http.request.before", "http.request.authed"],
  "url": "https://github.com/PeckBoard/chicken-coop/releases/download/v0.2.0/chicken-coop.wasm",
  "sha256": "3dfec521ea332a0e94fcd1b323b394f408b7b39d49c941405596d519f952a5f9",
  "min_peckboard": "0.0.131"
}
```
