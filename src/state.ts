// Roster + activity derivation — the data the 3D page animates from. Pure
// (host functions are injected as a port) so vitest covers it without an
// Extism runtime.
//
// Model: one BIRD per live session, plus the classic one-hen-per-active-card:
//   card worker session        → hen    (phases from the card's workflow step)
//   plain chat / expert        → rooster
//   repeating-task session     → barred hen
//   temp (pre-hatcher) session → bantam
//   subagent                   → chick, in its PARENT's breed palette,
//                                following the parent bird
// On cores without `peckboard_list_sessions_brief` only card hens appear —
// exactly the pre-0.3.0 behavior.
//
// Activity: each poll tails a bird's session event log (slim events) past a
// per-session cursor and counts `agent-tool-start` rows; the page pecks on
// observed deltas. The same tail feeds a pending-question heuristic
// (`question` / `question-resolved` kinds) so the (comparatively expensive)
// full-payload `sessionQuestions` host call only fires for sessions that
// actually have something pending.

import type { Card, SessionBrief, SlimEvent } from "./host";

/// How long a done/wont_do card keeps its hen in the roster so the page can
/// play the walk-home animation even if it wasn't watching live.
export const TERMINAL_LINGER_MS = 120_000;
/// A non-card session with no activity for this long is considered asleep:
/// its bird walks home and despawns. A pending question or a live chick
/// keeps the bird out regardless.
export const SESSION_STALE_MS = 600_000;
/// Sessions idle longer than this are ignored entirely (no tailing, no
/// roster entry) — bounds per-poll work on instances with much history.
export const SESSION_HORIZON_MS = 86_400_000;

export type Phase = "working" | "testing" | "done" | "wont_do";
export type ToolClass = "command" | "edit" | "read" | "other";
export type BirdKind = "hen" | "rooster" | "barred" | "bantam" | "chick";

/// A pending user question on a bird's session — the page shows an alert
/// over the bird and opens the Q&A modal from it. `data` is the raw question
/// event payload (questions array + card/project context when present).
export interface PendingQuestion {
  id: string;
  session_id: string;
  data: any;
}

export interface Bird {
  /// Roster key: the card id for card hens (stable across session restarts),
  /// the session id for every other bird.
  id: string;
  kind: BirdKind;
  /// Chicks only: the parent's breed, for the baby palette/silhouette.
  chick_kind: BirdKind | null;
  /// Chicks only: roster id of the parent bird, when it is rostered — the
  /// page makes the chick follow it. null = orphan (parent despawned).
  parent_id: string | null;
  card_id: string | null;
  project_id: string | null;
  project_name: string;
  title: string;
  /// Workflow step for card hens; null for session birds.
  step: string | null;
  phase: Phase;
  blocked: boolean;
  busy: boolean;
  activity: number;
  last_tool: string | null;
  tool_class: ToolClass | null;
  session_id: string | null;
  question: PendingQuestion | null;
}

/// The host functions state derivation needs, injectable for tests.
/// `sessionQuestions` and `listSessionsBrief` are optional: on an older core
/// the roster still builds — without alerts, and card-hens-only,
/// respectively. A throwing optional fn degrades the same way.
export interface HostPort {
  listCards(): Card[];
  listProjects(): { id: string; name: string }[];
  sessionEvents(
    sessionId: string,
    afterSeq: number,
  ): { events: SlimEvent[]; latest_seq: number | null };
  sessionQuestions?(sessionId: string): { id: string; data: any }[];
  listSessionsBrief?(): SessionBrief[];
}

/// Bucket a tool name into the peck style the page plays. Order matters:
/// command wins over edit wins over read.
export function classifyTool(name: string | null): ToolClass {
  const n = (name || "").toLowerCase();
  if (n === "") return "other";
  if (/bash|command|exec|shell|run_tests/.test(n)) return "command";
  if (/edit|write|patch|notebook/.test(n)) return "edit";
  if (/read|search|grep|glob|outline|symbol|list|fetch/.test(n)) return "read";
  return "other";
}

/// Parse the DB's timestamp strings (RFC3339 or SQLite's "YYYY-MM-DD
/// HH:MM:SS", both treated as UTC). NaN when unparseable.
export function parseTs(s: string | null): number {
  if (!s) return NaN;
  let t = Date.parse(s);
  if (!Number.isNaN(t)) return t;
  t = Date.parse(s.replace(" ", "T") + "Z");
  return t;
}

/// Phase for a card, or null when it gets no hen. `nowMs` bounds the
/// terminal linger window.
export function phaseForCard(card: Card, nowMs: number): Phase | null {
  const step = card.step;
  if (step === "backlog" || step === "todo") return null;
  if (step === "done" || step === "wont_do") {
    const ts = parseTs(card.completed_at) || parseTs(card.updated_at);
    if (Number.isNaN(ts) || nowMs - ts > TERMINAL_LINGER_MS) return null;
    return step === "done" ? "done" : "wont_do";
  }
  return step === "in_progress" ? "working" : "testing";
}

/// Breed for a non-worker session. Worker sessions never reach this (their
/// card hen covers them).
export function kindForSession(s: SessionBrief): BirdKind {
  if (s.expert_kind === "subagent" || s.parent_session_id) return "chick";
  if (s.is_temp) return "bantam";
  if (s.repeating_task_id) return "barred";
  return "rooster";
}

interface ActivityEntry {
  count: number;
  lastTool: string | null;
  lastClass: ToolClass | null;
}

// Per-session event cursors, per-bird activity, and per-session pending-
// question counters, kept in wasm globals. The instance persists across
// calls (calls are serialized); a rebuild resets the caches, which only
// costs a burst of catch-up pecks — no durable store needed.
const cursors: Record<string, number> = {};
const activity: Record<string, ActivityEntry> = {};
const pendingQ: Record<string, number> = {};

export function resetStateCache(): void {
  for (const k of Object.keys(cursors)) delete cursors[k];
  for (const k of Object.keys(activity)) delete activity[k];
  for (const k of Object.keys(pendingQ)) delete pendingQ[k];
}

/// Tail one session's slim events: bump the bird's activity on tool starts,
/// and keep the session's pending-question counter in sync.
function tailSession(port: HostPort, sid: string, birdId: string): void {
  const tail = port.sessionEvents(sid, cursors[sid] ?? 0);
  if (tail.latest_seq !== null) cursors[sid] = tail.latest_seq;
  let q = pendingQ[sid] ?? 0;
  const tools: SlimEvent[] = [];
  for (const e of tail.events) {
    if (e.kind === "agent-tool-start") tools.push(e);
    else if (e.kind === "question") q += 1;
    else if (e.kind === "question-resolved") q = Math.max(0, q - 1);
  }
  pendingQ[sid] = q;
  if (tools.length > 0) {
    const entry = (activity[birdId] = activity[birdId] || {
      count: 0,
      lastTool: null,
      lastClass: null,
    });
    entry.count += tools.length;
    const last = tools[tools.length - 1];
    entry.lastTool = last.name || null;
    entry.lastClass = classifyTool(last.name);
  }
}

/// Fetch the oldest pending question for a session, but only when the tail
/// heuristic says one is pending. Throws (older core, missing permission)
/// degrade to "no alert".
function questionFor(
  port: HostPort,
  sid: string | null,
): PendingQuestion | null {
  if (!sid || !port.sessionQuestions) return null;
  if ((pendingQ[sid] ?? 0) <= 0) return null;
  try {
    const qs = port.sessionQuestions(sid);
    if (qs.length === 0) {
      pendingQ[sid] = 0; // heuristic drifted; resync
      return null;
    }
    return { id: qs[0].id, session_id: sid, data: qs[0].data };
  } catch (e) {
    return null;
  }
}

/// One poll: cards + sessions → birds, tailing each live bird's session for
/// new tool events and pending questions.
export function buildState(port: HostPort, nowMs: number): { birds: Bird[] } {
  const cards = port.listCards();
  const projectNames: Record<string, string> = {};
  for (const p of port.listProjects()) projectNames[p.id] = p.name;

  const birds: Bird[] = [];
  const liveBirdIds: Record<string, boolean> = {};
  const liveSessionIds: Record<string, boolean> = {};
  /// worker session id → hen roster id, for chick parent resolution.
  const sessionToBird: Record<string, string> = {};

  // ── Card hens (unchanged model) ──────────────────────────────────────
  for (const card of cards) {
    const phase = phaseForCard(card, nowMs);
    if (phase === null) continue;
    liveBirdIds[card.id] = true;

    const sid = card.worker_session_id || card.last_worker_session_id;
    if (card.worker_session_id) sessionToBird[card.worker_session_id] = card.id;
    if (card.last_worker_session_id)
      sessionToBird[card.last_worker_session_id] = card.id;
    const watching = !!sid && (phase === "working" || phase === "testing");
    if (sid && watching) {
      liveSessionIds[sid] = true;
      tailSession(port, sid, card.id);
    }

    const entry = activity[card.id];
    birds.push({
      id: card.id,
      kind: "hen",
      chick_kind: null,
      parent_id: null,
      card_id: card.id,
      project_id: card.project_id,
      project_name: projectNames[card.project_id] || "",
      title: card.title,
      step: card.step,
      phase,
      blocked: !!card.blocked,
      busy: !!card.worker_session_id,
      activity: entry ? entry.count : 0,
      last_tool: entry ? entry.lastTool : null,
      tool_class: entry ? entry.lastClass : null,
      session_id: sid || null,
      question: watching ? questionFor(port, sid) : null,
    });
  }

  // ── Session birds (needs the brief-list host fn) ─────────────────────
  let sessions: SessionBrief[] | null = null;
  if (port.listSessionsBrief) {
    try {
      sessions = port.listSessionsBrief();
    } catch (e) {
      sessions = null;
    }
  }
  if (sessions) {
    const inHorizon = sessions.filter((s) => {
      if (s.is_worker) return false; // card hens cover workers
      const age = nowMs - parseTs(s.last_activity);
      return !Number.isNaN(age) && age < SESSION_HORIZON_MS;
    });

    // Chicks first: their liveness feeds the parents' keep-alive rule.
    const chicks = inHorizon.filter((s) => kindForSession(s) === "chick");
    const others = inHorizon.filter((s) => kindForSession(s) !== "chick");
    const liveChickParents: Record<string, boolean> = {};
    const liveChicks: SessionBrief[] = [];
    const doneChicks: SessionBrief[] = [];
    for (const s of chicks) {
      if (s.subagent_completed_at === null) {
        liveChicks.push(s);
        if (s.parent_session_id) liveChickParents[s.parent_session_id] = true;
      } else if (
        nowMs - parseTs(s.subagent_completed_at) <
        TERMINAL_LINGER_MS
      ) {
        doneChicks.push(s);
      }
    }

    const kindBySession: Record<string, BirdKind> = {};
    for (const s of sessions)
      kindBySession[s.session_id] = s.is_worker ? "hen" : kindForSession(s);

    const pushSessionBird = (
      s: SessionBrief,
      kind: BirdKind,
      phase: Phase,
      extra: Partial<Bird>,
    ) => {
      liveBirdIds[s.session_id] = true;
      liveSessionIds[s.session_id] = true;
      const entry = activity[s.session_id];
      birds.push({
        id: s.session_id,
        kind,
        chick_kind: null,
        parent_id: null,
        card_id: s.card_id,
        project_id: s.project_id,
        project_name: (s.project_id && projectNames[s.project_id]) || "",
        title: s.name,
        step: null,
        phase,
        blocked: false,
        busy: phase === "working",
        activity: entry ? entry.count : 0,
        last_tool: entry ? entry.lastTool : null,
        tool_class: entry ? entry.lastClass : null,
        session_id: s.session_id,
        question: phase === "working" ? questionFor(port, s.session_id) : null,
        ...extra,
      });
    };

    for (const s of others) {
      const age = nowMs - parseTs(s.last_activity);
      const kind = kindForSession(s);
      // Tail before deciding: the pending-question counter must reflect the
      // log even for a session that just went quiet.
      tailSession(port, s.session_id, s.session_id);
      liveSessionIds[s.session_id] = true; // keep cursor across asleep polls
      const alive =
        age < SESSION_STALE_MS ||
        (pendingQ[s.session_id] ?? 0) > 0 ||
        !!liveChickParents[s.session_id];
      if (alive) {
        pushSessionBird(s, kind, "working", {});
      } else if (age < SESSION_STALE_MS + TERMINAL_LINGER_MS) {
        pushSessionBird(s, kind, "done", {});
      }
      // else: asleep — no bird, caches GC'd below.
    }

    for (const s of liveChicks.concat(doneChicks)) {
      tailSession(port, s.session_id, s.session_id);
      const phase: Phase =
        s.subagent_completed_at === null ? "working" : "done";
      const parentSid = s.parent_session_id;
      const parentBird =
        (parentSid &&
          (sessionToBird[parentSid] ||
            (liveBirdIds[parentSid] ? parentSid : null))) ||
        null;
      const chickKind = (parentSid && kindBySession[parentSid]) || "hen";
      pushSessionBird(s, "chick", phase, {
        chick_kind: chickKind,
        parent_id: parentBird,
      });
    }
  }

  // GC caches for birds/sessions that left the roster entirely.
  for (const id of Object.keys(activity)) {
    if (!liveBirdIds[id]) delete activity[id];
  }
  for (const id of Object.keys(cursors)) {
    if (!liveSessionIds[id]) delete cursors[id];
  }
  for (const id of Object.keys(pendingQ)) {
    if (!liveSessionIds[id]) delete pendingQ[id];
  }

  return { birds };
}
