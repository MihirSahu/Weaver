import type { WeaverBuild } from "../shared/models";

export type CodexTurnStatus = "completed" | "interrupted" | "failed" | "inProgress";

export interface CodexTurnSnapshot {
  id: string;
  status: CodexTurnStatus;
  error?: { message?: string } | null;
}

export type ReconciliationDecision =
  | { status: "ready"; turnId: string; errorSummary?: undefined }
  | { status: "building"; turnId: string; errorSummary?: undefined }
  | { status: "failed"; turnId?: string; errorSummary: string };

export function decideBuildReconciliation(build: WeaverBuild, turns: CodexTurnSnapshot[]): ReconciliationDecision {
  const turn = build.turnId
    ? turns.find((candidate) => candidate.id === build.turnId)
    : turns.at(-1);

  if (!turn) {
    return {
      status: "failed",
      errorSummary: "Build submission was interrupted before Codex recorded a turn. Choose Weave again to continue.",
    };
  }
  if (turn.status === "completed") return { status: "ready", turnId: turn.id };
  if (turn.status === "inProgress") return { status: "building", turnId: turn.id };
  return {
    status: "failed",
    turnId: turn.id,
    errorSummary: turn.error?.message ?? `Codex turn ${turn.status}.`,
  };
}

export function shouldReconcileBeforeSubmit(build: WeaverBuild): boolean {
  return Boolean(build.threadId) || build.status === "submitted" || build.status === "building";
}

export function isStaleReconciliationSnapshot(startedFrom: WeaverBuild, current: WeaverBuild): boolean {
  return current.threadId !== startedFrom.threadId || current.turnId !== startedFrom.turnId ||
    current.status !== startedFrom.status || current.updatedAt !== startedFrom.updatedAt;
}

export function isTerminalBuildForTurn(build: WeaverBuild | undefined, threadId: string, turnId: string): boolean {
  return Boolean(build && (build.status === "ready" || build.status === "failed") &&
    build.threadId === threadId && build.turnId === turnId);
}
