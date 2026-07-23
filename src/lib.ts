// Hook dispatch and tiny shared helpers.

import { serveHttp, serveAuthed } from "./http";
import { skip } from "./verdict";

export function dispatch(hook: string, payload: any): string {
  switch (hook) {
    case "http.request.before":
      return serveHttp(payload);
    case "http.request.authed":
      return serveAuthed(payload);
    default:
      return skip();
  }
}

/// A readable message from any thrown value.
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
