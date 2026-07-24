// The plugin manifest Peckboard core reads at load. Kept in one place so the
// hook list, routes, and permissions stay reviewable together.

// Inline SVG (lucide "bird") for the sidebar entry; rendered sandboxed.
const ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M16 7h.01"/><path d="M3.4 18H12a8 8 0 0 0 8-8V7a4 4 0 0 0-7.28-2.3L2 20"/>' +
  '<path d="m20 7 2 .5-2 .5"/><path d="M10 18v3"/><path d="M14 17.75V21"/>' +
  '<path d="M7 18a6 6 0 0 0 3.84-10.61"/></svg>';

export function manifestJson(): string {
  return JSON.stringify({
    description:
      "A 3D chicken run visualizing every live session as a bird: hens for cards, " +
      "a rooster for chats, a barred hen for repeating tasks, a bantam for temp " +
      "sessions, and chicks that follow their parent bird for subagents — pecking " +
      "on tool activity, nesting during testing, raising an alert badge when a " +
      "worker asks a question.",
    version: "0.4.0",
    repository: "https://github.com/PeckBoard/chicken-coop",
    hooks: ["http.request.before", "http.request.authed"],
    sidebar_items: [
      {
        id: "chicken-coop",
        label: "Chicken Coop",
        icon: ICON,
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
