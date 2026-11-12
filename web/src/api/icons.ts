import type { Http } from "./http";
import type { IconImage } from "../lib/icons";

// App and project icons (ADR-0030): images read from a machine's folders by
// its agent (the icons/ area travels to remote machines, ADR-0026), and this
// computer's file picker. The mock is mockIcons.ts.

export type IconPick = { kind: "picked"; icon: IconImage } | { kind: "cancelled" } | { kind: "unsupported" };

export interface IconsApi {
  /** The best icon from dir up to root (a checkout), or null. */
  iconFind(dir: string, root?: string): Promise<IconImage | null>;
  /** Images in a project that could be its icon, best first. */
  iconCandidates(root: string): Promise<IconImage[]>;
  /** One image file. */
  iconFile(path: string): Promise<IconImage>;
  /** This computer's file picker, for an image. */
  iconPick(): Promise<IconPick>;
}

export function createIconsHttp(h: Http): IconsApi {
  const q = (params: Record<string, string>) => new URLSearchParams(params).toString();
  return {
    iconFind: async (dir, root) => (await h.json<{ icon: IconImage | null }>("GET", `/api/icons/find?${q(root ? { dir, root } : { dir })}`)).icon ?? null,
    iconCandidates: async (root) => (await h.json<{ icons: IconImage[] }>("GET", `/api/icons/candidates?${q({ root })}`)).icons ?? [],
    iconFile: async (path) => (await h.json<{ icon: IconImage }>("GET", `/api/icons/file?${q({ path })}`)).icon,
    async iconPick() {
      const res = await h.send("POST", "/api/icons/pick", {});
      if (res.status === 204) return { kind: "cancelled" };
      if (res.status === 501) return { kind: "unsupported" };
      if (!res.ok) throw await h.fail(res);
      const body = (await res.json()) as { icon?: IconImage };
      return body.icon ? { kind: "picked", icon: body.icon } : { kind: "cancelled" };
    },
  };
}
