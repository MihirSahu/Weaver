import { beforeEach, expect, it, vi } from "vitest";
import { buildStorageKey, findBuild, findBuildByThread, getBuilds, getSettings, saveBuild, threadStorageKey, transitionBuild, updateSettings } from "../src/shared/storage";
import type { WeaverBuild } from "../src/shared/models";

const records = new Map<string, unknown>();

beforeEach(() => {
  records.clear();
  Object.assign(globalThis, {
    chrome: {
      storage: {
        local: {
          get: vi.fn(async (keys: string[] | string | null) => {
            if (keys === null) return Object.fromEntries(records);
            const requested = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(requested.flatMap((key) => records.has(key) ? [[key, records.get(key)]] : []));
          }),
          set: vi.fn(async (values: Record<string, unknown>) => {
            await Promise.resolve();
            for (const [key, value] of Object.entries(values)) records.set(key, value);
          }),
        },
      },
    },
  });
});

function build(postId: string): WeaverBuild {
  return {
    postId, postUrl: `https://x.com/a/status/${postId}`, projectName: `idea-${postId}`, projectPath: `/Weaver/idea-${postId}`,
    threadId: `thr_${postId}`, status: "submitted", createdAt: "2026-08-05T00:00:00Z", updatedAt: "2026-08-05T00:00:00Z",
  };
}

it("transitions a build without losing its idempotency identity", () => {
  const ready = transitionBuild(build("123"), "ready");
  expect(ready).toMatchObject({ postId: "123", threadId: "thr_123", projectPath: "/Weaver/idea-123", status: "ready" });
});

it("stores concurrent tweets independently without a shared list update", async () => {
  await Promise.all([saveBuild(build("123")), saveBuild(build("456"))]);

  expect(records.get(buildStorageKey("123"))).toMatchObject({ postId: "123" });
  expect(records.get(buildStorageKey("456"))).toMatchObject({ postId: "456" });
  expect(records.get(threadStorageKey("thr_123"))).toBe("123");
  expect(await findBuildByThread("thr_456")).toMatchObject({ postId: "456" });
  expect((await getBuilds()).map((candidate) => candidate.postId).sort()).toEqual(["123", "456"]);
});

it("does not route an obsolete thread index to a build's replacement thread", async () => {
  const replacement = { ...build("123"), threadId: "thr_replacement" };
  records.set(buildStorageKey("123"), replacement);
  records.set(threadStorageKey("thr_obsolete"), "123");

  expect(await findBuildByThread("thr_obsolete")).toBeUndefined();
  expect(await findBuildByThread("thr_replacement")).toEqual(replacement);
});

it("migrates a matching legacy record on first lookup", async () => {
  records.set("weaverBuilds", [build("123")]);
  expect(await findBuild("123")).toMatchObject({ postId: "123" });
  expect(records.get(buildStorageKey("123"))).toMatchObject({ postId: "123" });
});

it("does not let legacy migration overwrite a concurrent newer save", async () => {
  const legacy = build("123");
  const ready = { ...legacy, status: "ready" as const, updatedAt: "2026-08-05T00:01:00Z" };
  records.set("weaverBuilds", [legacy]);

  await Promise.all([findBuild("123"), saveBuild(ready)]);

  expect(records.get(buildStorageKey("123"))).toEqual(ready);
});

it("serializes independent settings patches without losing either change", async () => {
  await Promise.all([
    updateSettings((current) => ({ ...current, projectRoot: "C:\\Weaver" })),
    updateSettings((current) => ({ ...current, openOnCompletion: false })),
  ]);

  expect(await getSettings()).toMatchObject({ projectRoot: "C:\\Weaver", openOnCompletion: false });
});
