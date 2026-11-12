import type { Http } from "./http";

// Installing and updating tools (plan §3, M5.1): dekit, Node and portless,
// as jobs (see jobs.ts).
// Add methods here and in createToolsHttp; the mock lives in mockTools.ts.
// Shared types can go in this file too, so the work stays out of client.ts.

export interface ToolsApi {}

export function createToolsHttp(_h: Http): ToolsApi {
  return {};
}
