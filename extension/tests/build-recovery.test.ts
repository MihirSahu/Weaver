import { describe, expect, it } from "vitest";
import {
  decideBuildReconciliation,
  isStaleReconciliationSnapshot,
  isTerminalBuildForTurn,
  shouldReconcileBeforeSubmit,
} from "../src/background/build-recovery";
import type { WeaverBuild } from "../src/shared/models";

function build(patch: Partial<WeaverBuild> = {}): WeaverBuild {
  return {
    postId: "123",
    postUrl: "https://x.com/a/status/123",
    projectName: "idea-123",
    projectPath: "/Weaver/idea-123",
    threadId: "thread-123",
    status: "submitted",
    createdAt: "2026-08-05T00:00:00Z",
    updatedAt: "2026-08-05T00:00:00Z",
    ...patch,
  };
}

describe("persisted build reconciliation", () => {
  it("makes a submitted thread with no turns retryable", () => {
    expect(decideBuildReconciliation(build(), [])).toEqual({
      status: "failed",
      errorSummary: "Build submission was interrupted before Codex recorded a turn. Choose Weave again to continue.",
    });
  });

  it("discovers an accepted turn when its response was never persisted", () => {
    const uncertain = build({ status: "failed", turnId: undefined });
    expect(shouldReconcileBeforeSubmit(uncertain)).toBe(true);
    expect(decideBuildReconciliation(uncertain, [{ id: "turn-latest", status: "inProgress" }])).toEqual({
      status: "building",
      turnId: "turn-latest",
    });
    expect(decideBuildReconciliation(uncertain, [{ id: "turn-latest", status: "completed" }])).toEqual({
      status: "ready",
      turnId: "turn-latest",
    });
  });

  it("requires a new submit path when no thread id was ever persisted", () => {
    expect(shouldReconcileBeforeSubmit(build({ status: "failed", threadId: "", turnId: undefined }))).toBe(false);
  });

  it("continues matching a recorded turn instead of a later Desktop turn", () => {
    const tracked = build({ status: "building", turnId: "turn-original" });
    expect(decideBuildReconciliation(tracked, [
      { id: "turn-original", status: "completed" },
      { id: "turn-followup", status: "failed", error: { message: "Follow-up failed" } },
    ])).toEqual({ status: "ready", turnId: "turn-original" });
  });

  it("does not let an older reconciliation overwrite a newer completion or retry", () => {
    const startedFrom = build({ status: "building", turnId: "turn-original" });
    expect(isStaleReconciliationSnapshot(startedFrom, build({ status: "ready", turnId: "turn-original" }))).toBe(true);
    expect(isStaleReconciliationSnapshot(startedFrom, build({ status: "building", turnId: "turn-retry" }))).toBe(true);
    expect(isStaleReconciliationSnapshot(startedFrom, build({
      status: "building",
      turnId: "turn-original",
      updatedAt: "2026-08-05T00:01:00Z",
    }))).toBe(true);
    expect(isStaleReconciliationSnapshot(startedFrom, startedFrom)).toBe(false);
  });

  it("preserves a terminal notification that arrives before turn/start returns", () => {
    expect(isTerminalBuildForTurn(build({ status: "ready", turnId: "turn-fast" }), "thread-123", "turn-fast")).toBe(true);
    expect(isTerminalBuildForTurn(build({ status: "failed", turnId: "turn-fast" }), "thread-123", "turn-fast")).toBe(true);
    expect(isTerminalBuildForTurn(build({ status: "building", turnId: "turn-fast" }), "thread-123", "turn-fast")).toBe(false);
  });
});
