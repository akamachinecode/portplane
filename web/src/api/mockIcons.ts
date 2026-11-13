import type { IconImage } from "../lib/icons";
import type { IconsApi } from "./icons";
import type { MockContext } from "./mockContext";

// The in-memory side of icons.ts for `?mock` and tests: a few folders have a
// favicon or a logo, the rest show their initials.

const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${body}</svg>`;

/** Made-up marks, one per kind of folder the mock has. */
const MARKS: Array<{ match: RegExp; path: string; svg: string }> = [
  {
    // a real-world shape: a tall, black-only favicon made for a white browser
    // tab (16×34). It must stay inside its square and show on a dark theme.
    match: /blog\/studio$/,
    path: "public/favicon.svg",
    svg: '<svg width="16" height="34" viewBox="0 0 16 34" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 1h12v4h-4v24h4v4H2v-4h4V5H2z" fill="black"/></svg>',
  },
  {
    match: /my-monorepo(-checkout)?\/apps\/web$/,
    path: "apps/web/public/favicon.svg",
    svg: svg('<rect width="32" height="32" rx="8" fill="#111827"/><path d="M9 21l7-12 7 12z" fill="#3dd68c"/>'),
  },
  {
    match: /my-monorepo(-checkout)?\/apps\/admin$/,
    path: "apps/admin/app/icon.svg",
    svg: svg('<rect width="32" height="32" rx="8" fill="#4f46e5"/><circle cx="16" cy="16" r="7" fill="none" stroke="#fff" stroke-width="3"/>'),
  },
  {
    match: /my-monorepo(-checkout)?\/apps\/docs$/,
    path: "apps/docs/public/logo.svg",
    svg: svg('<rect width="32" height="32" rx="8" fill="#f59e0b"/><path d="M10 9h9l3 3v11H10z" fill="#fff"/>'),
  },
  {
    match: /my-monorepo(-checkout)?$/,
    path: ".portplane/icon.svg",
    svg: svg('<rect width="32" height="32" rx="8" fill="#0f172a"/><rect x="8" y="8" width="7" height="7" rx="2" fill="#3dd68c"/><rect x="17" y="8" width="7" height="7" rx="2" fill="#94a3b8"/><rect x="8" y="17" width="7" height="7" rx="2" fill="#94a3b8"/><rect x="17" y="17" width="7" height="7" rx="2" fill="#3dd68c"/>'),
  },
];

const b64 = (s: string) => (typeof btoa === "function" ? btoa(s) : Buffer.from(s, "utf8").toString("base64"));

function image(dir: string, mark: (typeof MARKS)[number]): IconImage {
  const root = dir.replace(/\/apps\/[^/]+$/, "");
  return { path: `${root}/${mark.path}`, mime: "image/svg+xml", data: b64(mark.svg) };
}

export function createMockIcons(ctx: MockContext): IconsApi {
  return {
    async iconFind(dir) {
      const mark = MARKS.find((m) => m.match.test(dir.replace(/\/+$/, "")));
      return ctx.delay(mark ? image(dir, mark) : null, 60);
    },
    async iconCandidates(root) {
      const found = MARKS.filter((m) => !m.path.startsWith(".portplane") || m.match.test(root)).map((m) => ({ path: `${root}/${m.path}`, mime: "image/svg+xml", data: b64(m.svg) }));
      return ctx.delay(found, 200);
    },
    async iconFile(path) {
      const mark = MARKS.find((m) => path.endsWith(m.path)) ?? MARKS[0];
      return ctx.delay({ path, mime: "image/svg+xml", data: b64(mark.svg) }, 60);
    },
    iconPick: () => ctx.delay({ kind: "unsupported" as const }, 100),
  };
}
