// The plugin manifest Peckboard core reads at load. Kept in one place so the
// hook list, routes, and permissions stay reviewable together.

export function manifestJson(): string {
  return JSON.stringify({
    description:
      "A 3D chicken run visualizing the cards being worked on: one hen per active card — " +
      "out of the coop while working, pecking on tool activity, nesting during testing, " +
      "back into the coop when the card is done.",
    version: "0.1.0",
    repository: "https://github.com/PeckBoard/chicken-coop",
    hooks: ["http.request.before", "http.request.authed"],
    sidebar_items: [
      { id: "chicken-coop", label: "Chicken Coop", path: "/plugin-api/v1/chicken-coop" },
    ],
    http_routes: ["GET /plugin-api/v1/chicken-coop"],
    ui_routes: ["GET /api/plugin-ui/chicken-coop/state"],
    permissions: ["contribute_sidebar", "user_authority", "session_read"],
  });
}
