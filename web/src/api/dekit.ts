import type { Http } from "./http";

// The dekit part of the API (plan §4, M5.3): runners, task actions, task
// and project config, and output (M5.4).
// Add methods here and in createDekitHttp; the mock lives in mockDekit.ts.
// Shared types can go in this file too, so the work stays out of client.ts.

export interface DekitApi {}

export function createDekitHttp(_h: Http): DekitApi {
  return {};
}
