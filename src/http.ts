// HTTP surfaces: the served Chicken Coop page (`http.request.before`) and the
// authenticated app-UI state endpoint (`http.request.authed`) the page polls.

import { htmlResponse, jsonResponse } from "./verdict";
import { buildPage } from "./page";
import { buildState } from "./state";
import {
  answerQuestion,
  listCards,
  listProjects,
  sessionEvents,
  sessionQuestions,
} from "./host";
import { errMsg } from "./lib";

const PAGE_PATH = "/plugin-api/v1/chicken-coop";
const STATE_PATH = "/api/plugin-ui/chicken-coop/state";
const ANSWER_PATH = "/api/plugin-ui/chicken-coop/answer";

/// Serve the Chicken Coop page (the sidebar item opens this).
export function serveHttp(payload: any): string {
  const method = (
    payload && typeof payload.method === "string" ? payload.method : ""
  ).toUpperCase();
  const path = payload && typeof payload.path === "string" ? payload.path : "";
  if (method === "GET" && path === PAGE_PATH) {
    return htmlResponse(200, buildPage());
  }
  return htmlResponse(
    404,
    "<!doctype html><title>Not found</title><p>Not found.</p>",
  );
}

/// Authenticated endpoints: the roster state the page polls, and the answer
/// POST the Q&A modal submits (validated here, resolved by the host under
/// the user's authority).
export function serveAuthed(payload: any): string {
  const method = (
    payload && typeof payload.method === "string" ? payload.method : ""
  ).toUpperCase();
  const path = payload && typeof payload.path === "string" ? payload.path : "";

  try {
    if (method === "GET" && path === STATE_PATH) {
      const state = buildState(
        { listCards, listProjects, sessionEvents, sessionQuestions },
        Date.now(),
      );
      return jsonResponse(200, state);
    }
    if (method === "POST" && path === ANSWER_PATH) {
      let body: any = null;
      try {
        body = JSON.parse(typeof payload.body === "string" ? payload.body : "");
      } catch (e) {
        return jsonResponse(400, { error: "invalid JSON body" });
      }
      const sessionId =
        typeof body?.session_id === "string" ? body.session_id.trim() : "";
      const questionId =
        typeof body?.question_id === "string" ? body.question_id.trim() : "";
      const rejected = body?.rejected === true;
      const answers: Record<string, string> = {};
      if (
        body?.answers &&
        typeof body.answers === "object" &&
        !Array.isArray(body.answers)
      ) {
        for (const k of Object.keys(body.answers)) {
          if (typeof body.answers[k] === "string") answers[k] = body.answers[k];
        }
      }
      if (sessionId === "" || questionId === "") {
        return jsonResponse(400, {
          error: "session_id and question_id are required",
        });
      }
      if (!rejected && Object.keys(answers).length === 0) {
        return jsonResponse(400, { error: "answers required unless rejected" });
      }
      answerQuestion(sessionId, questionId, answers, rejected);
      return jsonResponse(200, { ok: true });
    }
  } catch (e) {
    return jsonResponse(400, { error: errMsg(e) });
  }
  return jsonResponse(404, { error: "not found" });
}
