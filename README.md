# Chicken Coop

A PeckBoard plugin that turns the instance's work-in-progress into a 3D
chicken run: one bird per live session, breed by session kind.

| Session kind                    | Bird                                                                                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Card worker                     | **Hen** — leaves the coop when the card starts, pecks on tool activity, nests during testing steps, walks home on done/wont_do                 |
| Chat (and non-subagent experts) | **Rooster** — tall comb, green-black sickle tail                                                                                               |
| Repeating task                  | **Barred hen** — gray/white barred plumage                                                                                                     |
| Temp (pre-hatcher)              | **Bantam** — small and pale                                                                                                                    |
| Subagent                        | **Chick** — a baby in its parent's palette that follows the parent bird; when the subagent completes it runs to the parent, hops, and vanishes |

Non-card birds despawn by walking home once their session has been idle for
10 minutes (a pending question or a live chick keeps them out); chicks live
exactly as long as `subagent_completed_at` is unset.

## How It Works

- **Page** (`GET /plugin-api/v1/chicken-coop`, sidebar item "Chicken Coop"):
  a self-contained three.js scene compiled into the wasm. Runs in the app's
  sandboxed plugin iframe; opened standalone it renders a demo roster.
- **State** (`GET /api/plugin-ui/chicken-coop/state`, authed): polled once a
  second through the parent fetch bridge. The plugin derives it live:
  - card hens: `peckboard_list_cards` — every card whose step is neither
    backlog/todo nor terminal gets a hen (`in_progress` → working, any other
    non-terminal step → testing). Done/wont-do cards linger for 2 minutes so
    the walk-home animation can play.
  - session birds: `peckboard_list_sessions_brief` (`session_read`, core ≥
    0.0.132) — a slim enumeration (kind flags, lineage, `last_activity`,
    `subagent_completed_at`; no conversation/model/prompt content) drives
    the rooster/barred/bantam/chick roster. On older cores the fn is absent
    and the coop degrades to card hens only.
  - activity: `peckboard_session_events` (slim event tail, `session_read`)
    on each card's worker session; `agent-tool-start` events increment a
    per-card counter, classified into peck styles (command / edit / read /
    other). The page pecks on observed deltas.
  - questions: `peckboard_session_questions` (`worker_questions`) surfaces a
    worker's unresolved `ask_user` question. The hen gets a bobbing "!" badge;
    clicking her opens a Q&A modal with the question, its options, and enough
    context to answer (card title/description, project, a workflow-position
    diagram, recent tool activity).
  - blocked cards: a blocked hen trudges to the fence and mopes there —
    hunched, head hung, wings slumped — beside a little painted stop stake;
    she rejoins the flock the moment the card unblocks.
- **Project pens**: when the live birds span two or more projects, the field
  splits into fenced pens — one per project, sorted by name, busier projects
  getting a wider share — each with a swung-open gate and a little wooden
  sign carrying the project name. Birds wander only inside their project's
  pen (chicks stay in their parent's pen); session birds without a project
  share the open commons strip along the camera edge, which doubles as the
  corridor birds walk between their gate and the shared coop and nests. The
  layout only re-computes when the project set changes, so pens never jump
  around between polls; with a single project (or none) the field stays one
  open run. Layout math lives in `page/pens.js` (vitest-covered).
- **Eggs & daily stats**: cards reaching done leave eggs by the nests for the
  24h horizon — a loose dozen, then a pile (wont_do lays nothing) — and a
  painted wooden board beside the coop tallies eggs (cards done) and tool
  calls today (the `stats` object in the state payload).
- **Identity UI**: hovering any bird fades in a hand-painted name tag
  (card title / session label, project underneath); clicking any bird opens
  a small info popover — breed and session kind, phase (working / testing /
  walking home / idle), project, last tool + activity count, and
  last-activity age (from the state payload's `last_activity_ts`). A bird
  with a pending question badge opens the Q&A modal instead; Escape or
  click-outside closes either.
- **Day/night cycle**: sky, sun, and ambient light track the real local
  clock — dawn, day, dusk, and a dim blue night with a warm glow from the
  coop window and doorway. Idle birds (no live work) roost beside the coop
  after dark; birds with active work stay out and keep pecking. Force any
  time of day with `?hour=` (see Development below).
- **Sound** (synthesized WebAudio, no audio files): soft clucks on pecks —
  sharp for commands, mid for edits, soft for reads — a rooster crow when a
  question badge first appears, and a faint daytime breeze with distant
  songbirds. Default muted; the speaker toggle in the bottom-right corner
  persists in localStorage, and audio only starts after a user gesture
  (browser autoplay policy).
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
`peckboard_answer_question` (`worker_questions` grant), and the full
every-session roster needs `peckboard_list_sessions_brief` (core ≥ 0.0.132).

## Development

```sh
./build.sh              # npm install (first run) + two-stage bundle + extism-js
npm test                # vitest for the state derivation
```

The standalone demo (`npm run demo`, open `.demo/coop-demo.html`) shows every
breed plus chicks across three demo projects (`coop-app`, `egg-farm`,
`feed-mill` — so the fenced project pens render standalone), with hover name
tags and the click info popover working on the demo roster. Query params for
browser-driven verification:
`?focus=<bird id>` frames one bird close up (family stays visible, strangers
hide), `&yaw=<radians>` poses it at a fixed heading in the open field,
`?hour=<0..24, fractional>` forces the day/night cycle to any local hour
(`?hour=21.5` → night: roosting idle birds and the glowing coop window;
`?hour=12` → noon), and `?err=1` throws a probe error — uncaught errors
render into a visible `#coop-errors` box (`data-count` attribute) since the
harness can't read the console.

`npm run bundle` compiles the page (page/main.js + three.js) to a minified
IIFE embedded as a JSON-escaped string in `src/generated/pageBundle.ts`, then
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
  "description": "3D chicken run visualizing every live session as a bird — hens, roosters, barred hens, bantams, and chicks that follow their parents.",
  "author": "PeckBoard",
  "homepage": "https://github.com/PeckBoard/chicken-coop",
  "version": "0.3.1",
  "tags": ["visualization", "fun", "workers"],
  "category": "visualization",
  "hooks": ["http.request.before", "http.request.authed"],
  "url": "https://github.com/PeckBoard/chicken-coop/releases/download/v0.3.1/chicken-coop.wasm",
  "sha256": "bd99ad90f29f1db0c61321454b695a56518e8ed0c5130a1f395b59020806488f",
  "min_peckboard": "0.0.132"
}
```
