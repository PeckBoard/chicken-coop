// HTTP surfaces: the served Chicken Coop page (`http.request.before`) and the
// authenticated app-UI state endpoint (`http.request.authed`) the page polls.

import { htmlResponse, jsonResponse } from "./verdict";
import { buildPage } from "./page";
import { buildState } from "./state";
import { listCards, listProjects, sessionEvents } from "./host";
import { errMsg } from "./lib";

const PAGE_PATH = "/plugin-api/v1/chicken-coop";
const STATE_PATH = "/api/plugin-ui/chicken-coop/state";

/// Serve the Chicken Coop page (the sidebar item opens this).
export function serveHttp(payload: any): string {
  const method = (payload && typeof payload.method === "string" ? payload.method : "").toUpperCase();
  const path = payload && typeof payload.path === "string" ? payload.path : "";
  if (method === "GET" && path === PAGE_PATH) {
    return htmlResponse(200, buildPage());
  }
  return htmlResponse(404, "<!doctype html><title>Not found</title><p>Not found.</p>");
}

/// Authenticated state endpoint: the roster of chickens + per-card activity.
export function serveAuthed(payload: any): string {
  const method = (payload && typeof payload.method === "string" ? payload.method : "").toUpperCase();
  const path = payload && typeof payload.path === "string" ? payload.path : "";

  try {
    if (method === "GET" && path === STATE_PATH) {
      const state = buildState({ listCards, listProjects, sessionEvents }, Date.now());
      return jsonResponse(200, state);
    }
  } catch (e) {
    return jsonResponse(400, { error: errMsg(e) });
  }
  return jsonResponse(404, { error: "not found" });
}
