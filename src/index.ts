// Wasm entry points. Peckboard calls `manifest` at load, `init` on approval,
// `handle` per hook dispatch, and `shutdown` on unload.

import { manifestJson } from "./manifest";
import { dispatch } from "./lib";

export function manifest(): void {
  Host.outputString(manifestJson());
}

export function init(): void {
  Host.outputString(JSON.stringify({ ok: true }));
}

export function shutdown(): void {
  Host.outputString(JSON.stringify({ ok: true }));
}

export function handle(): void {
  const call = JSON.parse(Host.inputString());
  const hook = typeof call?.hook === "string" ? call.hook : "";
  Host.outputString(dispatch(hook, call?.payload ?? {}));
}
