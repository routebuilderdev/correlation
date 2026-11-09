/**
 * Task inputs are derived, never chosen, so orchestrator and contract cannot
 * disagree without the disagreement being visible (the contract rejects it as
 * E13 rather than trusting us).
 */
export { AGENT_COUNT, expectedAnswer, taskInput } from "@correlation/shared";

/** `agent-01` … `agent-20`; position in this list is the agent index. */
export function agentId(index: number): string {
  return `agent-${String(index + 1).padStart(2, "0")}`;
}

export function promptFor(n: number): string {
  return (
    `Compute a = (n * ${37}) mod ${1_000_003} for n = ${n}. ` +
    `Reply with only JSON: {"n": ${n}, "a": <answer>}`
  );
}
