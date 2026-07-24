import { beforeEach, describe, expect, it } from "vitest";
import {
  buildState,
  classifyTool,
  kindForSession,
  parseTs,
  phaseForCard,
  resetStateCache,
  SESSION_STALE_MS,
  TERMINAL_LINGER_MS,
  type Bird,
  type HostPort,
} from "../src/state";
import type { Card, SessionBrief, SlimEvent } from "../src/host";

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

function sb(over: Partial<SessionBrief>): SessionBrief {
  return {
    session_id: "x",
    name: "x",
    is_worker: false,
    is_expert: false,
    expert_kind: null,
    card_id: null,
    project_id: null,
    parent_session_id: null,
    is_temp: false,
    repeating_task_id: null,
    last_activity: "2026-07-23T11:59:00Z",
    subagent_completed_at: null,
    ...over,
  };
}

function port(
  cards: Card[],
  tails: Record<string, SlimEvent[]>,
  sessions?: SessionBrief[],
): HostPort & { seen: number[] } {
  const seen: number[] = [];
  const p: HostPort & { seen: number[] } = {
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
  if (sessions) p.listSessionsBrief = () => sessions;
  return p;
}

function byId(birds: Bird[], id: string): Bird {
  const b = birds.find((x) => x.id === id);
  if (!b) throw new Error(`no bird ${id}: ${birds.map((x) => x.id)}`);
  return b;
}

/// last_activity string for an age in ms before NOW.
function ago(ms: number): string {
  return new Date(NOW - ms).toISOString();
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

describe("kindForSession", () => {
  it("maps session flags to breeds", () => {
    expect(kindForSession(sb({}))).toBe("rooster");
    expect(kindForSession(sb({ is_expert: true, expert_kind: "pm" }))).toBe(
      "rooster",
    );
    expect(kindForSession(sb({ is_temp: true }))).toBe("bantam");
    expect(kindForSession(sb({ repeating_task_id: "rt1" }))).toBe("barred");
    expect(
      kindForSession(sb({ expert_kind: "subagent", parent_session_id: "s1" })),
    ).toBe("chick");
  });
});

describe("buildState — card hens", () => {
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
    expect(state.birds).toHaveLength(1);
    expect(state.birds[0]).toMatchObject({
      id: "c1",
      kind: "hen",
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
    expect(state.birds[0].activity).toBe(2);
    expect(state.birds[0].tool_class).toBe("edit");

    // Nothing new: count stays.
    state = buildState(p, NOW);
    expect(state.birds[0].activity).toBe(2);
  });

  it("drops cards that leave the roster and GCs their activity", () => {
    const tails = { s1: [{ seq: 1, kind: "agent-tool-start", name: "Bash" }] };
    const p = port([card({})], tails);
    expect(buildState(p, NOW).birds).toHaveLength(1);

    const gone = port([], tails);
    expect(buildState(gone, NOW).birds).toHaveLength(0);
  });

  it("uses last_worker_session_id between worker chunks", () => {
    const tails = { s9: [{ seq: 5, kind: "agent-tool-start", name: "Read" }] };
    const p = port(
      [card({ worker_session_id: null, last_worker_session_id: "s9" })],
      tails,
    );
    const state = buildState(p, NOW);
    expect(state.birds[0]).toMatchObject({
      activity: 1,
      tool_class: "read",
      busy: false,
    });
  });

  it("attaches a question only when the tail saw one pending, and tolerates a missing host fn", () => {
    const tails: Record<string, SlimEvent[]> = {
      s1: [{ seq: 1, kind: "question", name: null }],
    };
    const p = port([card({})], tails);

    // Port without sessionQuestions (older core): no alert, no crash — but
    // the tail still counted the pending question.
    expect(buildState(p, NOW).birds[0].question).toBeNull();

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
    const hen = buildState(withQ, NOW).birds[0];
    expect(hen.question).toEqual({
      id: "q-1",
      session_id: "s1",
      data: qData,
    });
    expect(hen.session_id).toBe("s1");

    // A throwing host fn degrades to no alert.
    const throwing: HostPort = {
      ...p,
      sessionQuestions: () => {
        throw new Error("plugin lacks the 'worker_questions' permission");
      },
    };
    expect(buildState(throwing, NOW).birds[0].question).toBeNull();

    // Once the tail sees the resolution, the fetch stops firing entirely.
    tails.s1.push({ seq: 2, kind: "question-resolved", name: null });
    let fetches = 0;
    const counting: HostPort = {
      ...p,
      sessionQuestions: () => {
        fetches += 1;
        return [];
      },
    };
    expect(buildState(counting, NOW).birds[0].question).toBeNull();
    expect(fetches).toBe(0);
  });
});

describe("buildState — session birds", () => {
  it("spawns breeds per session kind and skips workers (hens cover them)", () => {
    const sessions = [
      sb({ session_id: "s1", name: "worker", is_worker: true }),
      sb({ session_id: "chat", name: "Morning chat" }),
      sb({ session_id: "cron", name: "Nightly", repeating_task_id: "rt1" }),
      sb({ session_id: "tmp", name: "research", is_temp: true }),
    ];
    const p = port([card({})], {}, sessions);
    const { birds } = buildState(p, NOW);
    expect(birds.map((b) => b.id).sort()).toEqual([
      "c1",
      "chat",
      "cron",
      "tmp",
    ]);
    expect(byId(birds, "chat")).toMatchObject({
      kind: "rooster",
      phase: "working",
      title: "Morning chat",
      step: null,
    });
    expect(byId(birds, "cron").kind).toBe("barred");
    expect(byId(birds, "tmp").kind).toBe("bantam");
  });

  it("walks stale sessions home, then despawns them", () => {
    const fresh = port([], {}, [
      sb({ session_id: "chat", last_activity: ago(SESSION_STALE_MS - 5000) }),
    ]);
    expect(buildState(fresh, NOW).birds[0].phase).toBe("working");

    const stale = port([], {}, [
      sb({ session_id: "chat", last_activity: ago(SESSION_STALE_MS + 5000) }),
    ]);
    expect(buildState(stale, NOW).birds[0].phase).toBe("done");

    const asleep = port([], {}, [
      sb({
        session_id: "chat",
        last_activity: ago(SESSION_STALE_MS + TERMINAL_LINGER_MS + 5000),
      }),
    ]);
    expect(buildState(asleep, NOW).birds).toHaveLength(0);
  });

  it("keeps a stale session out while a question is pending", () => {
    const tails: Record<string, SlimEvent[]> = {
      chat: [{ seq: 1, kind: "question", name: null }],
    };
    const p = port([], tails, [
      sb({
        session_id: "chat",
        last_activity: ago(SESSION_STALE_MS + TERMINAL_LINGER_MS + 5000),
      }),
    ]);
    // Within the horizon but far past stale: the pending question holds it.
    const { birds } = buildState(p, NOW);
    expect(birds).toHaveLength(1);
    expect(birds[0].phase).toBe("working");
  });
});

describe("buildState — chicks", () => {
  it("gives a chick its parent's breed and roster id (card hen parent)", () => {
    const sessions = [
      sb({ session_id: "s1", name: "worker", is_worker: true }),
      sb({
        session_id: "sub1",
        name: "sub: recon",
        is_expert: true,
        expert_kind: "subagent",
        parent_session_id: "s1",
      }),
    ];
    const p = port([card({})], {}, sessions);
    const chick = byId(buildState(p, NOW).birds, "sub1");
    expect(chick).toMatchObject({
      kind: "chick",
      chick_kind: "hen",
      parent_id: "c1", // the hen's roster id is the CARD id
      phase: "working",
      title: "sub: recon",
    });
  });

  it("follows a chat parent and keeps that parent alive past staleness", () => {
    const sessions = [
      sb({
        session_id: "chat",
        name: "Morning chat",
        last_activity: ago(SESSION_STALE_MS + TERMINAL_LINGER_MS + 60_000),
      }),
      sb({
        session_id: "sub1",
        expert_kind: "subagent",
        parent_session_id: "chat",
      }),
    ];
    const p = port([], {}, sessions);
    const { birds } = buildState(p, NOW);
    const parent = byId(birds, "chat");
    expect(parent.phase).toBe("working"); // live chick pins the parent out
    const chick = byId(birds, "sub1");
    expect(chick.chick_kind).toBe("rooster");
    expect(chick.parent_id).toBe("chat");
  });

  it("orphans a chick whose parent despawned, lingers on completion, then despawns", () => {
    const orphan = port([], {}, [
      sb({
        session_id: "sub1",
        expert_kind: "subagent",
        parent_session_id: "gone",
      }),
    ]);
    const b = buildState(orphan, NOW).birds[0];
    expect(b.parent_id).toBeNull();
    expect(b.chick_kind).toBe("hen"); // unknown parent defaults to hen

    const doneRecent = port([], {}, [
      sb({
        session_id: "sub1",
        expert_kind: "subagent",
        parent_session_id: "gone",
        subagent_completed_at: ago(TERMINAL_LINGER_MS - 5000),
      }),
    ]);
    expect(buildState(doneRecent, NOW).birds[0].phase).toBe("done");

    const doneOld = port([], {}, [
      sb({
        session_id: "sub1",
        expert_kind: "subagent",
        parent_session_id: "gone",
        subagent_completed_at: ago(TERMINAL_LINGER_MS + 5000),
      }),
    ]);
    expect(buildState(doneOld, NOW).birds).toHaveLength(0);
  });
});

describe("buildState — degraded ports", () => {
  it("builds card hens only without listSessionsBrief, or when it throws", () => {
    const p = port([card({})], {});
    const { birds } = buildState(p, NOW);
    expect(birds).toHaveLength(1);
    expect(birds[0].kind).toBe("hen");

    const throwing: HostPort = {
      ...port([card({})], {}),
      listSessionsBrief: () => {
        throw new Error("unknown host function");
      },
    };
    const state = buildState(throwing, NOW);
    expect(state.birds).toHaveLength(1);
    expect(state.birds[0].kind).toBe("hen");
  });
});

describe("buildState — last_activity_ts", () => {
  it("exposes card updated_at for hens and session last_activity for others", () => {
    const sessions = [sb({ session_id: "chat", last_activity: ago(60_000) })];
    const p = port([card({})], {}, sessions);
    const { birds } = buildState(p, NOW);
    expect(byId(birds, "c1").last_activity_ts).toBe(
      Date.parse("2026-07-23T11:59:30Z"),
    );
    expect(byId(birds, "chat").last_activity_ts).toBe(NOW - 60_000);
  });

  it("degrades to null when the timestamp is unparseable", () => {
    const p = port([card({ updated_at: "not a date" })], {});
    expect(buildState(p, NOW).birds[0].last_activity_ts).toBeNull();
  });
});