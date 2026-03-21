/**
 * Graph-based pipeline loop validator.
 *
 * Uses Tarjan's SCC algorithm to detect configurations where transactions
 * could oscillate out of controlled cycles.
 *
 * Constraint: for each non-trivial SCC (size ≥ 2),
 *   exit_nodes ⊆ entry_nodes
 *
 * where:
 *   entry_nodes = SCC nodes with at least one incoming edge from outside the SCC
 *   exit_nodes  = SCC nodes with at least one outgoing edge to outside the SCC
 *
 * Rationale: if a node exits the cycle but was not an entry point, transactions
 * can flow out of the cycle in an uncontrolled way, causing oscillation.
 * A fully closed SCC (exit_nodes = ∅) is always valid.
 *
 * Graph nodes are "budgetAlias:accountId" pairs (account-level, not budget-level,
 * because split steps route within the same budget).
 */

type NodeId = string; // "budgetAlias:accountId"

export type ResolvedStep =
  | {
      type: "mirror";
      srcAlias: string;
      srcAccountIds: string[];
      dstAlias: string;
      dstAccountId: string;
    }
  | {
      type: "split";
      budgetAlias: string;
      srcAccountIds: string[];
      dstAccountIds: string[];
    };

export type SCCViolation = {
  sccNodes: NodeId[];
  /** exit_nodes that are NOT entry_nodes — these are the problematic nodes */
  offendingExitNodes: NodeId[];
  entryNodes: NodeId[];
};

export function buildPipelineGraph(
  steps: ResolvedStep[]
): Map<NodeId, Set<NodeId>> {
  const graph = new Map<NodeId, Set<NodeId>>();

  function ensureNode(n: NodeId): void {
    if (!graph.has(n)) graph.set(n, new Set());
  }

  function addEdge(from: NodeId, to: NodeId): void {
    ensureNode(from);
    ensureNode(to);
    graph.get(from)!.add(to);
  }

  for (const step of steps) {
    if (step.type === "mirror") {
      const dstNode = `${step.dstAlias}:${step.dstAccountId}`;
      ensureNode(dstNode);
      for (const srcId of step.srcAccountIds) {
        addEdge(`${step.srcAlias}:${srcId}`, dstNode);
      }
    } else {
      // split: same-budget source → destination(s)
      for (const dstId of step.dstAccountIds) {
        ensureNode(`${step.budgetAlias}:${dstId}`);
      }
      for (const srcId of step.srcAccountIds) {
        const srcNode = `${step.budgetAlias}:${srcId}`;
        for (const dstId of step.dstAccountIds) {
          addEdge(srcNode, `${step.budgetAlias}:${dstId}`);
        }
      }
    }
  }

  return graph;
}

/** Returns SCCViolation[] — empty means the pipeline is loop-safe. */
export function validatePipelineGraph(steps: ResolvedStep[]): SCCViolation[] {
  const graph = buildPipelineGraph(steps);
  const sccs = tarjanSCC(graph);
  const violations: SCCViolation[] = [];

  for (const scc of sccs) {
    if (scc.length < 2) continue;

    const sccSet = new Set(scc);
    const entryNodes = new Set<NodeId>();
    const exitNodes = new Set<NodeId>();

    for (const node of scc) {
      // Outgoing: edges to nodes outside this SCC
      for (const neighbor of graph.get(node) ?? new Set<NodeId>()) {
        if (!sccSet.has(neighbor)) {
          exitNodes.add(node);
        }
      }
    }

    // Incoming from outside: scan all edges in the graph
    for (const [src, neighbors] of graph) {
      if (sccSet.has(src)) continue; // internal edge
      for (const dst of neighbors) {
        if (sccSet.has(dst)) {
          entryNodes.add(dst);
        }
      }
    }

    const offendingExitNodes = scc.filter(
      (n) => exitNodes.has(n) && !entryNodes.has(n)
    );

    if (offendingExitNodes.length > 0) {
      violations.push({
        sccNodes: scc,
        offendingExitNodes,
        entryNodes: [...entryNodes],
      });
    }
  }

  return violations;
}

/** Tarjan's SCC algorithm. Returns one array per SCC. */
function tarjanSCC(graph: Map<NodeId, Set<NodeId>>): NodeId[][] {
  const index = new Map<NodeId, number>();
  const lowlink = new Map<NodeId, number>();
  const onStack = new Set<NodeId>();
  const stack: NodeId[] = [];
  const sccs: NodeId[][] = [];
  let counter = 0;

  function strongconnect(v: NodeId): void {
    index.set(v, counter);
    lowlink.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);

    for (const w of graph.get(v) ?? new Set<NodeId>()) {
      if (!index.has(w)) {
        strongconnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!));
      }
    }

    if (lowlink.get(v) === index.get(v)) {
      const scc: NodeId[] = [];
      let w: NodeId;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      sccs.push(scc);
    }
  }

  for (const v of graph.keys()) {
    if (!index.has(v)) {
      strongconnect(v);
    }
  }

  return sccs;
}
