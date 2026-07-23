// Roster + activity derivation — the data the 3D page animates from. Pure
// (host functions are injected as a port) so vitest covers it without an
// Extism runtime.
//
// Model: one chicken per card that is actively being worked. A card maps to a
// phase by its workflow step:
//   backlog / todo            → no chicken (still cooped up)
//   in_progress               → "working"  (out pecking in the run)
//   done / wont_do (recent)   → "done" / "wont_do" (walking home; the UI
//                               despawns it at the coop door)
//   any other non-terminal    → "testing"  (review/validation… — on the nest)
//
// Activity: each poll tails the card's worker-session event log (slim events)
// past a per-session cursor and counts `agent-tool-start` rows. The count is
// monotonic per card; the page pecks on observed deltas. Counting a session's
// history on first sight is deliberate — a freshly-seen busy session bursts a
// few pecks (harmless, honest) instead of silently swallowing quick activity.

import type { Card, SlimEvent } from "./host";

/// How long a done/wont_do card keeps its chicken in the roster so the page
/// can play the walk-home animation even if it wasn't watching live.
export const TERMINAL_LINGER_MS = 120_000;

export type Phase = "working" | "testing" | "done" | "wont_do";
export type ToolClass = "command" | "edit" | "read" | "other";

/// A pending user question on a chicken's worker session — the page shows an
/// alert over the hen and opens the Q&A modal from it. `data` is the raw
/// question event payload (questions array + card/project context).
export interface PendingQuestion {
  id: string;
  session_id: string;
  data: any;
}

export interface Chicken {
  card_id: string;
  project_id: string;
  project_name: string;
  title: string;
  step: string;
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
/// `sessionQuestions` is optional: on a core without the `worker_questions`
/// host functions the roster still builds, just with no alerts.
export interface HostPort {
  listCards(): Card[];
  listProjects(): { id: string; name: string }[];
  sessionEvents(
    sessionId: string,
    afterSeq: number,
  ): { events: SlimEvent[]; latest_seq: number | null };
  sessionQuestions?(sessionId: string): { id: string; data: any }[];
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

/// Phase for a card, or null when it gets no chicken. `nowMs` bounds the
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

interface ActivityEntry {
  count: number;
  lastTool: string | null;
  lastClass: ToolClass | null;
}

// Per-session event cursors and per-card activity, kept in wasm globals. The
// instance persists across calls (calls are serialized); a rebuild resets the
// caches, which only costs a burst of catch-up pecks — no durable store needed.
const cursors: Record<string, number> = {};
const activity: Record<string, ActivityEntry> = {};

export function resetStateCache(): void {
  for (const k of Object.keys(cursors)) delete cursors[k];
  for (const k of Object.keys(activity)) delete activity[k];
}

/// One poll: cards → chickens, tailing each active card's worker session for
/// new tool events.
export function buildState(
  port: HostPort,
  nowMs: number,
): { chickens: Chicken[] } {
  const cards = port.listCards();
  const projectNames: Record<string, string> = {};
  for (const p of port.listProjects()) projectNames[p.id] = p.name;

  const chickens: Chicken[] = [];
  const liveCardIds: Record<string, boolean> = {};
  const liveSessionIds: Record<string, boolean> = {};

  for (const card of cards) {
    const phase = phaseForCard(card, nowMs);
    if (phase === null) continue;
    liveCardIds[card.id] = true;

    const sid = card.worker_session_id || card.last_worker_session_id;
    if (sid && (phase === "working" || phase === "testing")) {
      liveSessionIds[sid] = true;
      const tail = port.sessionEvents(sid, cursors[sid] ?? 0);
      if (tail.latest_seq !== null) cursors[sid] = tail.latest_seq;
      const tools = tail.events.filter((e) => e.kind === "agent-tool-start");
      if (tools.length > 0) {
        const entry = (activity[card.id] = activity[card.id] || {
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
    // Pending user question, if the host exposes them: oldest unresolved
    // question on the worker session. A throw (older core, permission not
    // yet granted) degrades to "no alert" rather than failing the roster.
    let question: PendingQuestion | null = null;
    if (
      sid &&
      (phase === "working" || phase === "testing") &&
      port.sessionQuestions
    ) {
      try {
        const qs = port.sessionQuestions(sid);
        if (qs.length > 0)
          question = { id: qs[0].id, session_id: sid, data: qs[0].data };
      } catch (e) {
        question = null;
      }
    }

    const entry = activity[card.id];
    chickens.push({
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
      question,
    });
  }

  // GC caches for cards/sessions that left the roster entirely.
  for (const id of Object.keys(activity)) {
    if (!liveCardIds[id]) delete activity[id];
  }
  for (const id of Object.keys(cursors)) {
    if (!liveSessionIds[id]) delete cursors[id];
  }

  return { chickens };
}
