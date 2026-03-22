import { describe, it, expect } from "vitest";
import { validatePipelineGraph, buildPipelineGraph, type ResolvedStep } from "../validator";

// Helpers
function mirror(
  srcAlias: string,
  srcAccountIds: string[],
  dstAlias: string,
  dstAccountId: string
): ResolvedStep {
  return { type: "mirror", srcAlias, srcAccountIds, dstAlias, dstAccountId };
}

function split(
  budgetAlias: string,
  srcAccountIds: string[],
  dstAccountIds: string[]
): ResolvedStep {
  return { type: "split", budgetAlias, srcAccountIds, dstAccountIds };
}

describe("validatePipelineGraph", () => {
  it("empty pipeline is valid", () => {
    expect(validatePipelineGraph([])).toEqual([]);
  });

  it("linear chain a→b→c is valid (no cycle)", () => {
    const steps: ResolvedStep[] = [
      mirror("a", ["checking"], "b", "recv"),
      mirror("b", ["recv"], "c", "recv"),
    ];
    expect(validatePipelineGraph(steps)).toEqual([]);
  });

  it("simple A↔B invert mirror is valid (closed cycle, exit_nodes=∅)", () => {
    // A:pay_b → A:pay_a (invert), A:pay_a → A:pay_b (invert)
    // Forms a closed 2-node SCC with no external exits
    const steps: ResolvedStep[] = [
      mirror("A", ["pay_b"], "A", "pay_a"),
      mirror("A", ["pay_a"], "A", "pay_b"),
    ];
    expect(validatePipelineGraph(steps)).toEqual([]);
  });

  it("joint-finances pattern is valid (all exit nodes are entry nodes)", () => {
    // A:recv → Joint:pay_a → Joint:pay_b → B:recv → Joint:pay_b (cycle)
    // Plus external entries: A:checking → A:recv, B:checking → B:recv,
    //   Joint:checking → pay_a/pay_b (splits)
    const steps: ResolvedStep[] = [
      // Phase 1: splits
      split("A", ["checking"], ["recv"]),
      split("B", ["checking"], ["recv"]),
      split("Joint", ["checking"], ["joint_expenses"]),
      split("Joint", ["checking"], ["pay_a", "pay_b"]),
      split("Joint", ["checking"], ["pay_b", "pay_a"]),
      // Phase 2: mirrors into Joint
      mirror("A", ["checking"], "Joint", "a_indv"),
      mirror("B", ["checking"], "Joint", "b_indv"),
      mirror("A", ["recv"], "Joint", "pay_a"),
      mirror("B", ["recv"], "Joint", "pay_b"),
      // Phase 3: invert mirrors within Joint
      mirror("Joint", ["pay_b"], "Joint", "pay_a"),
      mirror("Joint", ["pay_a"], "Joint", "pay_b"),
      // Phase 4: mirrors back out
      mirror("Joint", ["pay_a"], "A", "recv"),
      mirror("Joint", ["pay_b"], "B", "recv"),
      mirror("Joint", ["joint_expenses"], "A", "joint"),
      mirror("Joint", ["joint_expenses"], "B", "joint"),
    ];
    const violations = validatePipelineGraph(steps);
    expect(violations).toEqual([]);
  });

  it("invalid: interior exit from cycle (a→b→c→d→b, d→e→f)", () => {
    // SCC = {b, c, d}
    // entry_nodes = {b} (a→b from outside)
    // exit_nodes = {d} (d→e to outside)
    // d is NOT in entry_nodes → violation
    const steps: ResolvedStep[] = [
      mirror("budget", ["a"], "budget", "b"),
      mirror("budget", ["b"], "budget", "c"),
      mirror("budget", ["c"], "budget", "d"),
      mirror("budget", ["d"], "budget", "b"), // closes the cycle
      mirror("budget", ["d"], "budget", "e"), // d also exits to e
      mirror("budget", ["e"], "budget", "f"),
    ];
    const violations = validatePipelineGraph(steps);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.offendingExitNodes).toContain("budget:d");
    expect(violations[0]!.entryNodes).toContain("budget:b");
    expect(violations[0]!.sccNodes).toContain("budget:b");
    expect(violations[0]!.sccNodes).toContain("budget:c");
    expect(violations[0]!.sccNodes).toContain("budget:d");
  });

  it("invalid: cycle with a node that exits but has no entry from outside", () => {
    // Cycle: x→y→z→x, and z also goes to external w
    // entry_nodes = {} (no external nodes point into cycle)
    // exit_nodes = {z}
    // z not in entry_nodes → violation
    const steps: ResolvedStep[] = [
      mirror("bud", ["x"], "bud", "y"),
      mirror("bud", ["y"], "bud", "z"),
      mirror("bud", ["z"], "bud", "x"), // cycle
      mirror("bud", ["z"], "bud", "w"), // z exits to w
    ];
    const violations = validatePipelineGraph(steps);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.offendingExitNodes).toContain("bud:z");
  });

  it("valid: entry node that is also exit node (symmetric bridge)", () => {
    // External a→b, b is in cycle b↔c, b also exits to d
    // entry_nodes = {b}, exit_nodes = {b}
    // exit_nodes ⊆ entry_nodes → valid
    const steps: ResolvedStep[] = [
      mirror("bud", ["a"], "bud", "b"), // a→b (external entry)
      mirror("bud", ["b"], "bud", "c"), // cycle
      mirror("bud", ["c"], "bud", "b"), // cycle
      mirror("bud", ["b"], "bud", "d"), // b exits to d
    ];
    const violations = validatePipelineGraph(steps);
    expect(violations).toEqual([]);
  });

  it("buildPipelineGraph creates correct edges for mirror steps", () => {
    const steps: ResolvedStep[] = [
      mirror("src", ["checking", "savings"], "dst", "recv"),
    ];
    const graph = buildPipelineGraph(steps);
    expect(graph.get("src:checking")?.has("dst:recv")).toBe(true);
    expect(graph.get("src:savings")?.has("dst:recv")).toBe(true);
  });

  it("buildPipelineGraph creates correct edges for split steps", () => {
    const steps: ResolvedStep[] = [
      split("Joint", ["checking"], ["pay_a", "pay_b"]),
    ];
    const graph = buildPipelineGraph(steps);
    expect(graph.get("Joint:checking")?.has("Joint:pay_a")).toBe(true);
    expect(graph.get("Joint:checking")?.has("Joint:pay_b")).toBe(true);
  });
});
