import { beforeEach, describe, expect, it } from "vitest";
import {
  buildState,
  classifyTool,
  parseTs,
  phaseForCard,
  resetStateCache,
  TERMINAL_LINGER_MS,
  type HostPort,
} from "../src/state";
import type { Card, SlimEvent } from "../src/host";

const NOW = Date.parse("2026-07-23T12:00:00Z");

function card(over: Partial<Card>): Card {
  return {
    id: "c1",
    project_id: "p1",
    title: "Lay an egg",
    step: "in_progress",
    blocked: false,
    worker_session_id: "s1",
    last_worker_session_id: null,
    completed_at: null,
    updated_at: "2026-07-23T11:59:30Z",
    ...over,
  };
}

function port(
  cards: Card[],
  tails: Record<string, SlimEvent[]>,
): HostPort & { seen: number[] } {
  const seen: number[] = [];
  return {
    seen,
    listCards: () => cards,
    listProjects: () => [{ id: "p1", name: "Farm" }],
    sessionEvents: (sid, after) => {
      seen.push(after);
      const events = (tails[sid] || []).filter((e) => e.seq > after);
      return {
        events,
        latest_seq: events.length ? events[events.length - 1].seq : null,
      };
    },
  };
}

beforeEach(() => resetStateCache());

describe("classifyTool", () => {
  it("buckets tool names by peck style, command first", () => {
    expect(classifyTool("Bash")).toBe("command");
    expect(classifyTool("mcp__peckboard__run_command")).toBe("command");
    expect(classifyTool("run_tests")).toBe("command");
    expect(classifyTool("Edit")).toBe("edit");
    expect(classifyTool("write_file")).toBe("edit");
    expect(classifyTool("Read")).toBe("read");
    expect(classifyTool("search_files")).toBe("read");
    expect(classifyTool("TodoWrite")).toBe("edit");
    expect(classifyTool("mystery_tool")).toBe("other");
    expect(classifyTool(null)).toBe("other");
  });
});

describe("parseTs", () => {
  it("parses RFC3339 and SQLite formats as UTC", () => {
    expect(parseTs("2026-07-23T12:00:00Z")).toBe(NOW);
    expect(parseTs("2026-07-23 12:00:00")).toBe(NOW);
    expect(Number.isNaN(parseTs("not a date"))).toBe(true);
    expect(Number.isNaN(parseTs(null))).toBe(true);
  });
});

describe("phaseForCard", () => {
  it("maps steps to phases", () => {
    expect(phaseForCard(card({ step: "backlog" }), NOW)).toBeNull();
    expect(phaseForCard(card({ step: "todo" }), NOW)).toBeNull();
    expect(phaseForCard(card({ step: "in_progress" }), NOW)).toBe("working");
    expect(phaseForCard(card({ step: "review" }), NOW)).toBe("testing");
    expect(phaseForCard(card({ step: "validation" }), NOW)).toBe("testing");
  });

  it("keeps recently finished cards briefly, drops old ones", () => {
    const recent = card({ step: "done", completed_at: "2026-07-23T11:59:00Z" });
    expect(phaseForCard(recent, NOW)).toBe("done");
    const old = card({
      step: "done",
      completed_at: new Date(NOW - TERMINAL_LINGER_MS - 1000).toISOString(),
    });
    expect(phaseForCard(old, NOW)).toBeNull();
    const wontDo = card({
      step: "wont_do",
      completed_at: null,
      updated_at: "2026-07-23T11:59:50Z",
    });
    expect(phaseForCard(wontDo, NOW)).toBe("wont_do");
  });
});

describe("buildState", () => {
  it("counts tool events across polls with a per-session cursor", () => {
    const tails: Record<string, SlimEvent[]> = {
      s1: [
        { seq: 1, kind: "agent-start", name: null },
        { seq: 2, kind: "agent-tool-start", name: "Bash" },
        { seq: 3, kind: "agent-text", name: null },
      ],
    };
    const p = port([card({})], tails);

    let state = buildState(p, NOW);
    expect(state.chickens).toHaveLength(1);
    expect(state.chickens[0]).toMatchObject({
      card_id: "c1",
      project_name: "Farm",
      phase: "working",
      activity: 1,
      last_tool: "Bash",
      tool_class: "command",
      busy: true,
    });

    // New events past the cursor: an edit lands, count goes to 2.
    tails.s1.push({ seq: 4, kind: "agent-tool-start", name: "Edit" });
    state = buildState(p, NOW);
    expect(p.seen).toEqual([0, 3]); // second poll tailed after seq 3
    expect(state.chickens[0].activity).toBe(2);
    expect(state.chickens[0].tool_class).toBe("edit");

    // Nothing new: count stays.
    state = buildState(p, NOW);
    expect(state.chickens[0].activity).toBe(2);
  });

  it("drops cards that leave the roster and GCs their activity", () => {
    const tails = { s1: [{ seq: 1, kind: "agent-tool-start", name: "Bash" }] };
    const p = port([card({})], tails);
    expect(buildState(p, NOW).chickens).toHaveLength(1);

    const gone = port([], tails);
    expect(buildState(gone, NOW).chickens).toHaveLength(0);
  });

  it("uses last_worker_session_id between worker chunks", () => {
    const tails = { s9: [{ seq: 5, kind: "agent-tool-start", name: "Read" }] };
    const p = port(
      [card({ worker_session_id: null, last_worker_session_id: "s9" })],
      tails,
    );
    const state = buildState(p, NOW);
    expect(state.chickens[0]).toMatchObject({
      activity: 1,
      tool_class: "read",
      busy: false,
    });
  });

  it("attaches the oldest unresolved question and tolerates a missing host fn", () => {
    const tails = { s1: [] as SlimEvent[] };
    const p = port([card({})], tails);

    // Port without sessionQuestions (older core): no alert, no crash.
    expect(buildState(p, NOW).chickens[0].question).toBeNull();

    const qData = {
      questions: [
        {
          question: "Which DB?",
          header: "Setup",
          options: [{ label: "SQLite", description: "" }],
        },
      ],
      cardTitle: "Lay an egg",
    };
    const withQ: HostPort = {
      ...p,
      sessionQuestions: (sid) =>
        sid === "s1" ? [{ id: "q-1", data: qData }] : [],
    };
    const chick = buildState(withQ, NOW).chickens[0];
    expect(chick.question).toEqual({
      id: "q-1",
      session_id: "s1",
      data: qData,
    });
    expect(chick.session_id).toBe("s1");

    // A throwing host fn degrades to no alert.
    const throwing: HostPort = {
      ...p,
      sessionQuestions: () => {
        throw new Error("plugin lacks the 'worker_questions' permission");
      },
    };
    expect(buildState(throwing, NOW).chickens[0].question).toBeNull();
  });
});
