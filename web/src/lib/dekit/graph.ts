// A small dependency graph around one task (plan §4.3): what it needs to
// the left, what needs it to the right, two levels each way.

export interface GraphNode {
  id: string;
  col: number; // -2..2, 0 is the task
  row: number;
}

export interface GraphEdge {
  from: string; // the dependency
  to: string; // the task that needs it
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  cols: number[];
  rows: number;
}

/** deps: task → the tasks it needs. */
export function neighbourhood(center: string, deps: Map<string, string[]>, depth = 2, maxPerCol = 6): Graph {
  const dependents = new Map<string, string[]>();
  for (const [task, ds] of deps) for (const d of ds) dependents.set(d, [...(dependents.get(d) ?? []), task]);
  const col = new Map<string, number>([[center, 0]]);
  const edges: GraphEdge[] = [];
  const seenEdge = new Set<string>();
  const addEdge = (from: string, to: string) => {
    const k = `${from}>${to}`;
    if (!seenEdge.has(k)) {
      seenEdge.add(k);
      edges.push({ from, to });
    }
  };
  let frontier = [center];
  for (let level = 1; level <= depth; level++) {
    const next: string[] = [];
    for (const t of frontier) {
      for (const d of deps.get(t) ?? []) {
        if (!col.has(d)) {
          col.set(d, -level);
          next.push(d);
        }
        if (col.get(d)! < col.get(t)!) addEdge(d, t);
      }
    }
    frontier = next;
  }
  frontier = [center];
  for (let level = 1; level <= depth; level++) {
    const next: string[] = [];
    for (const t of frontier) {
      for (const d of dependents.get(t) ?? []) {
        if (!col.has(d)) {
          col.set(d, level);
          next.push(d);
        }
        if (col.get(d)! > col.get(t)!) addEdge(t, d);
      }
    }
    frontier = next;
  }
  const byCol = new Map<number, string[]>();
  for (const [id, c] of col) byCol.set(c, [...(byCol.get(c) ?? []), id]);
  const nodes: GraphNode[] = [];
  const kept = new Set<string>();
  for (const [c, ids] of byCol) {
    ids.sort();
    ids.slice(0, maxPerCol).forEach((id, row) => {
      nodes.push({ id, col: c, row });
      kept.add(id);
    });
  }
  const cols = [...byCol.keys()].sort((a, b) => a - b);
  return {
    nodes,
    edges: edges.filter((e) => kept.has(e.from) && kept.has(e.to)),
    cols,
    rows: Math.max(1, ...[...byCol.values()].map((ids) => Math.min(ids.length, maxPerCol))),
  };
}
