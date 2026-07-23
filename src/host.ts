// FFI layer: the Peckboard core host functions this plugin calls, and the
// host_call marshaling helper. All host calls are kept LAZY (inside functions)
// so the pure modules that import these helpers load under vitest without an
// Extism runtime.

type HostFn = (offset: bigint) => bigint;

/// Call a host function and parse its JSON response, surfacing an
/// `{"error": ...}` envelope (or a trap) as a thrown Error.
export function hostCall(name: string, input: unknown): any {
  const f = (Host.getFunctions() as Record<string, HostFn>)[name];
  const mem = Memory.fromString(JSON.stringify(input));
  const out = f(mem.offset);
  const parsed = JSON.parse(Memory.find(out).readString());
  if (parsed && parsed.error !== undefined && parsed.error !== null) {
    throw new Error(String(parsed.error));
  }
  return parsed;
}

/// A card row as serialized by `peckboard_list_cards` (the DB model; the
/// fields this plugin reads).
export interface Card {
  id: string;
  project_id: string;
  title: string;
  step: string;
  blocked: boolean;
  worker_session_id: string | null;
  last_worker_session_id: string | null;
  completed_at: string | null;
  updated_at: string;
}

/// A slim event row from `peckboard_session_events` — kind + tool name only,
/// no payloads.
export interface SlimEvent {
  seq: number;
  kind: string;
  name: string | null;
}

export function listCards(): Card[] {
  const res = hostCall("peckboard_list_cards", {});
  return Array.isArray(res?.cards) ? res.cards : [];
}

export function listProjects(): { id: string; name: string }[] {
  const res = hostCall("peckboard_list_projects", {});
  return Array.isArray(res?.projects) ? res.projects : [];
}

export function sessionEvents(
  sessionId: string,
  afterSeq: number,
): { events: SlimEvent[]; latest_seq: number | null } {
  const res = hostCall("peckboard_session_events", {
    session_id: sessionId,
    after_seq: afterSeq,
  });
  return {
    events: Array.isArray(res?.events) ? res.events : [],
    latest_seq: typeof res?.latest_seq === "number" ? res.latest_seq : null,
  };
}

/// An unresolved `question` event as returned by
/// `peckboard_session_questions` — full payload (question list, card
/// context), unlike the slim activity events.
export interface QuestionEvent {
  id: string;
  seq: number;
  ts: number;
  data: any;
}

export function sessionQuestions(sessionId: string): QuestionEvent[] {
  const res = hostCall("peckboard_session_questions", {
    session_id: sessionId,
  });
  return Array.isArray(res?.questions) ? res.questions : [];
}

/// Resolve a pending question as the authenticated user. `answers` maps
/// question index ("0", "1", …) to the chosen label / typed text — the same
/// shape core's own UI posts. Throws on a host-side refusal.
export function answerQuestion(
  sessionId: string,
  questionId: string,
  answers: Record<string, string>,
  rejected: boolean,
): void {
  hostCall("peckboard_answer_question", {
    session_id: sessionId,
    question_id: questionId,
    answers,
    rejected,
  });
}

/// A session row from `peckboard_list_sessions_brief` (core ≥ 0.0.132) —
/// kind flags and lineage only, no conversation/model/prompt content.
export interface SessionBrief {
  session_id: string;
  name: string;
  is_worker: boolean;
  is_expert: boolean;
  expert_kind: string | null;
  card_id: string | null;
  project_id: string | null;
  parent_session_id: string | null;
  is_temp: boolean;
  repeating_task_id: string | null;
  last_activity: string;
  subagent_completed_at: string | null;
}

export function listSessionsBrief(): SessionBrief[] {
  const res = hostCall("peckboard_list_sessions_brief", {});
  return Array.isArray(res?.sessions) ? res.sessions : [];
}
