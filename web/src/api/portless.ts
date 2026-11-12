import type { Http } from "./http";

// The portless part of the API (plan §5, M5.2): proxy, routes, aliases,
// certificates, hosts and doctor.
// Add methods here and in createPortlessHttp; the mock lives in mockPortless.ts.
// Shared types can go in this file too, so the work stays out of client.ts.

export interface PortlessApi {}

export function createPortlessHttp(_h: Http): PortlessApi {
  return {};
}
