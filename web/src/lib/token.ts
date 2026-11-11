// The binary writes a per-run token into index.html (ADR-0008). In `pnpm dev`
// the placeholder stays, and the dev proxy must be given the token instead.
const PLACEHOLDER = "__PORTPLANE_TOKEN__";

export function readToken(doc: Pick<Document, "querySelector">): string | null {
  const value = doc.querySelector('meta[name="portplane-token"]')?.getAttribute("content") ?? "";
  if (value === "" || value === PLACEHOLDER) return null;
  return value;
}
