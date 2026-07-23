// The plugin manifest Peckboard core reads at load. Kept in one place so the
// hook list, routes, and permissions stay reviewable together.

export function manifestJson(): string {
  return JSON.stringify({
    description:
      "A 3D chicken run visualizing every live session as a bird: hens for cards, " +
      "a rooster for chats, a barred hen for repeating tasks, a bantam for temp " +
      "sessions, and chicks that follow their parent bird for subagents — pecking " +
      "on tool activity, nesting during testing, raising an alert badge when a " +
      "worker asks a question.",
    version: "0.3.0",
    repository: "https://github.com/PeckBoard/chicken-coop",
    hooks: ["http.request.before", "http.request.authed"],
    sidebar_items: [
      {
        id: "chicken-coop",
        label: "Chicken Coop",
        path: "/plugin-api/v1/chicken-coop",
      },
    ],
    http_routes: ["GET /plugin-api/v1/chicken-coop"],
    ui_routes: [
      "GET /api/plugin-ui/chicken-coop/state",
      "POST /api/plugin-ui/chicken-coop/answer",
    ],
    permissions: [
      "contribute_sidebar",
      "user_authority",
      "session_read",
      "worker_questions",
    ],
  });
}
