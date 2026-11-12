// Defaults for "Add an app" (plan §4.6): a task name and a URL name from
// the folder, and the checks portless applies to names.

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function relParts(folder: string, root: string): string[] {
  const f = folder.replace(/\\/g, "/").replace(/\/+$/, "");
  const r = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const rel = f === r ? "" : f.startsWith(`${r}/`) ? f.slice(r.length + 1) : f.split("/").pop() ?? "";
  return rel.split("/").filter(Boolean);
}

/** A task path from the folder, not one of taken: "apps/api" → "api". */
export function suggestPath(folder: string, root: string, taken: Set<string>): string {
  const parts = relParts(folder, root);
  const base = slug(parts[parts.length - 1] ?? root.split(/[\\/]/).pop() ?? "app") || "app";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** A portless name: the folder, under the project's name when nested ("api.shop"). */
export function suggestAppName(folder: string, root: string): string {
  const parts = relParts(folder, root);
  const project = slug(root.split(/[\\/]/).filter(Boolean).pop() ?? "");
  const leaf = slug(parts[parts.length - 1] ?? "");
  if (!leaf) return project || "app";
  if (parts.length === 1 || !parts[0]) return leaf;
  const top = slug(parts[0]);
  return leaf === top ? leaf : `${leaf}.${top}`;
}

/** A portless name problem, or null: lowercase labels with dots between. */
export function validUrlName(name: string): string | null {
  const n = name.trim().replace(/\.localhost$/, "");
  if (!n) return "Enter a name, such as api.";
  for (const label of n.split(".")) {
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label) || label.length > 63) return "Use lowercase letters, digits and hyphens, with dots between parts.";
  }
  return null;
}
