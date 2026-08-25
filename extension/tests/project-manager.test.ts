import { describe, expect, it, vi } from "vitest";
import type { CodexClient } from "../src/background/codex-client";
import type { PostContext } from "../src/shared/models";
import {
  assertDirectChild,
  createProjectSlug,
  isAbsoluteHostPath,
  prepareProject,
  recordProjectThread,
} from "../src/background/project-manager";

describe("project slug", () => {
  it("uses lowercase ASCII, caps the descriptive part, and retains the post id", () => {
    const slug = createProjectSlug("Crème brûlée! Build <this> / safely with a very long descriptive ending", "195123456789");
    const [description] = slug.split("-195123456789");
    expect(slug).toMatch(/^[a-z0-9-]+-195123456789$/);
    expect(description!.length).toBeLessThanOrEqual(48);
    expect(slug).not.toContain("<");
  });

  it("uses a stable fallback for symbol-only text", () => {
    expect(createProjectSlug("✨ / \\", "123")).toBe("weave-123");
  });
});

describe("host path boundaries", () => {
  it("accepts direct children on Windows and POSIX", () => {
    expect(() => assertDirectChild("C:\\Users\\me\\Weaver", "C:\\Users\\me\\Weaver\\idea-123", true)).not.toThrow();
    expect(() => assertDirectChild("/Users/me/Weaver", "/Users/me/Weaver/idea-123", false)).not.toThrow();
  });

  it("rejects siblings and nested directories", () => {
    expect(() => assertDirectChild("C:\\Weaver", "C:\\Other\\idea-123", true)).toThrow();
    expect(() => assertDirectChild("/home/me/Weaver", "/home/me/Weaver/group/idea-123", false)).toThrow();
  });

  it("recognizes platform absolute paths", () => {
    expect(isAbsoluteHostPath("C:\\Weaver", true)).toBe(true);
    expect(isAbsoluteHostPath("relative\\Weaver", true)).toBe(false);
    expect(isAbsoluteHostPath("/home/me/Weaver", false)).toBe(true);
  });
});

it("creates only directories and never invokes Git", async () => {
  const request = vi.fn(async (method: string) => {
    if (method === "command/exec") return { exitCode: 0, stdout: "C:\\Users\\me\r\n", stderr: "" };
    if (method === "fs/readDirectory") return { entries: [] };
    return {};
  });
  const post: PostContext = {
    postId: "195123456789",
    canonicalUrl: "https://x.com/thenanyu/status/195123456789",
    authorDisplayName: "Nan Yu",
    authorHandle: "@thenanyu",
    text: "Issue token pledges",
    mediaUrls: [],
    outboundUrls: [],
    capturedAt: "2026-08-05T12:00:00.000Z",
  };

  const project = await prepareProject(
    { request } as unknown as CodexClient,
    { platformOs: "windows" },
    post,
    null,
  );

  expect(project.projectPath).toBe("C:\\Users\\me\\Weaver\\issue-token-pledges-195123456789");
  expect(request.mock.calls.filter(([method]) => method === "fs/createDirectory")).toHaveLength(2);
  expect(JSON.stringify(request.mock.calls)).not.toMatch(/git/i);
});

it("persists the planned child before its create request can disconnect", async () => {
  const events: string[] = [];
  const request = vi.fn(async (method: string, params?: { path?: string }) => {
    if (method === "command/exec") return { exitCode: 0, stdout: "C:\\Users\\me\r\n", stderr: "" };
    if (method === "fs/readDirectory") return { entries: [] };
    if (method === "fs/createDirectory" && params?.path?.endsWith("idea-123")) events.push("create-child");
    return {};
  });
  const post: PostContext = {
    postId: "123", canonicalUrl: "https://x.com/a/status/123", authorDisplayName: "A", authorHandle: "@a",
    text: "Idea", mediaUrls: [], outboundUrls: [], capturedAt: "2026-08-05T12:00:00.000Z",
  };

  await prepareProject({ request } as unknown as CodexClient, { platformOs: "windows" }, post, null, undefined, async () => {
    events.push("persist-plan");
  });

  expect(events).toEqual(["persist-plan", "create-child"]);
});

it("retries a marked persisted project under its original root after the default root changes", async () => {
  const request = vi.fn(async (method: string, params?: { path?: string }) => {
    if (method === "command/exec") return { exitCode: 0, stdout: "C:\\Users\\me\r\n", stderr: "" };
    if (method === "fs/readDirectory" && params?.path === "C:\\Old-Weaver-Root") {
      return { entries: [{ fileName: "idea-123", isDirectory: true, isFile: false }] };
    }
    if (method === "fs/readDirectory") {
      return { entries: [{ fileName: ".weaver-project.json", isDirectory: false, isFile: true }] };
    }
    if (method === "fs/getMetadata" && params?.path?.endsWith(".weaver-project.json")) {
      return { isDirectory: false, isFile: true, isSymlink: false };
    }
    if (method === "fs/getMetadata") return { isDirectory: true, isFile: false, isSymlink: false };
    if (method === "fs/readFile") {
      return { dataBase64: btoa(`${JSON.stringify({
        version: 1,
        postId: "123",
        projectName: "idea-123",
      }, null, 2)}\n`) };
    }
    return {};
  });
  const post: PostContext = {
    postId: "123", canonicalUrl: "https://x.com/a/status/123", authorDisplayName: "A", authorHandle: "@a",
    text: "Idea", mediaUrls: [], outboundUrls: [], capturedAt: "2026-08-05T12:00:00.000Z",
  };

  const project = await prepareProject(
    { request } as unknown as CodexClient,
    { platformOs: "windows" },
    post,
    "D:\\New-Weaver-Root",
    "C:\\Old-Weaver-Root\\idea-123",
  );

  expect(project).toMatchObject({
    projectRoot: "C:\\Old-Weaver-Root",
    projectPath: "C:\\Old-Weaver-Root\\idea-123",
  });
  expect(request.mock.calls.filter(([method]) => method === "fs/createDirectory")).toHaveLength(1);
});

it("recovers a marker-owned deterministic project when Chrome storage is missing", async () => {
  const request = vi.fn(async (method: string, params?: { path?: string }) => {
    if (method === "command/exec") return { exitCode: 0, stdout: "C:\\Users\\me\r\n", stderr: "" };
    if (method === "fs/readDirectory" && params?.path === "C:\\Weaver") {
      return { entries: [{ fileName: "idea-123", isDirectory: true, isFile: false }] };
    }
    if (method === "fs/readDirectory") {
      return { entries: [{ fileName: ".weaver-project.json", isDirectory: false, isFile: true }] };
    }
    if (method === "fs/getMetadata" && params?.path?.endsWith(".weaver-project.json")) {
      return { isDirectory: false, isFile: true, isSymlink: false };
    }
    if (method === "fs/getMetadata") return { isDirectory: true, isFile: false, isSymlink: false };
    if (method === "fs/readFile") {
      return { dataBase64: btoa(`${JSON.stringify({
        version: 1,
        postId: "123",
        projectName: "idea-123",
        threadId: "thread-123",
      }, null, 2)}\n`) };
    }
    return {};
  });
  const post: PostContext = {
    postId: "123", canonicalUrl: "https://x.com/a/status/123", authorDisplayName: "A", authorHandle: "@a",
    text: "Idea", mediaUrls: [], outboundUrls: [], capturedAt: "2026-08-05T12:00:00.000Z",
  };

  await expect(prepareProject(
    { request } as unknown as CodexClient,
    { platformOs: "windows" },
    post,
    "C:\\Weaver",
  )).resolves.toMatchObject({
    projectPath: "C:\\Weaver\\idea-123",
    wasExisting: true,
    recoveredThreadId: "thread-123",
  });
  expect(request.mock.calls.filter(([method, params]) => method === "fs/createDirectory" && params?.path === "C:\\Weaver\\idea-123")).toHaveLength(0);
});

it("records the exact Codex thread in the project marker", async () => {
  const request = vi.fn(async (_method: string, _params?: { path?: string; dataBase64?: string }) => ({}));
  const post: PostContext = {
    postId: "123", canonicalUrl: "https://x.com/a/status/123", authorDisplayName: "A", authorHandle: "@a",
    text: "Idea", mediaUrls: [], outboundUrls: [], capturedAt: "2026-08-05T12:00:00.000Z",
  };

  await recordProjectThread(
    { request } as unknown as CodexClient,
    { platformOs: "windows" },
    {
      projectRoot: "C:\\Weaver",
      projectName: "idea-123",
      projectPath: "C:\\Weaver\\idea-123",
      wasExisting: false,
    },
    post,
    "thread-123",
  );

  const write = request.mock.calls.find(([method]) => method === "fs/writeFile");
  expect(write?.[1]).toMatchObject({ path: "C:\\Weaver\\idea-123\\.weaver-project.json" });
  expect(JSON.parse(atob((write?.[1] as { dataBase64: string }).dataBase64))).toEqual({
    version: 1,
    postId: "123",
    projectName: "idea-123",
    threadId: "thread-123",
  });
});

it("rejects a same-named project without a matching Weaver marker when Chrome storage is missing", async () => {
  const request = vi.fn(async (method: string, params?: { path?: string }) => {
    if (method === "command/exec") return { exitCode: 0, stdout: "C:\\Users\\me\r\n", stderr: "" };
    if (method === "fs/readDirectory" && params?.path === "C:\\Weaver") {
      return { entries: [{ fileName: "idea-123", isDirectory: true, isFile: false }] };
    }
    if (method === "fs/readDirectory") return { entries: [] };
    if (method === "fs/getMetadata") return { isDirectory: true, isFile: false, isSymlink: false };
    return {};
  });
  const post: PostContext = {
    postId: "123", canonicalUrl: "https://x.com/a/status/123", authorDisplayName: "A", authorHandle: "@a",
    text: "Idea", mediaUrls: [], outboundUrls: [], capturedAt: "2026-08-05T12:00:00.000Z",
  };

  await expect(prepareProject(
    { request } as unknown as CodexClient,
    { platformOs: "windows" },
    post,
    "C:\\Weaver",
  )).rejects.toThrow(/not marked as a Weaver project/);
});

it("rejects an unmarked persisted directory that already contains user files", async () => {
  const request = vi.fn(async (method: string, params?: { path?: string }) => {
    if (method === "command/exec") return { exitCode: 0, stdout: "C:\\Users\\me\r\n", stderr: "" };
    if (method === "fs/readDirectory" && params?.path === "C:\\Weaver") {
      return { entries: [{ fileName: "idea-123", isDirectory: true, isFile: false }] };
    }
    if (method === "fs/readDirectory") return { entries: [{ fileName: "user-file.txt", isDirectory: false, isFile: true }] };
    if (method === "fs/getMetadata") return { isDirectory: true, isFile: false, isSymlink: false };
    return {};
  });
  const post: PostContext = {
    postId: "123", canonicalUrl: "https://x.com/a/status/123", authorDisplayName: "A", authorHandle: "@a",
    text: "Idea", mediaUrls: [], outboundUrls: [], capturedAt: "2026-08-05T12:00:00.000Z",
  };

  await expect(prepareProject(
    { request } as unknown as CodexClient,
    { platformOs: "windows" },
    post,
    "C:\\Weaver",
    "C:\\Weaver\\idea-123",
  )).rejects.toThrow(/not owned by Weaver/);
});

it("claims an empty directory left by an uncertain create request", async () => {
  const request = vi.fn(async (method: string, params?: { path?: string }) => {
    if (method === "command/exec") return { exitCode: 0, stdout: "C:\\Users\\me\r\n", stderr: "" };
    if (method === "fs/readDirectory" && params?.path === "C:\\Weaver") {
      return { entries: [{ fileName: "idea-123", isDirectory: true, isFile: false }] };
    }
    if (method === "fs/readDirectory") return { entries: [] };
    if (method === "fs/getMetadata") return { isDirectory: true, isFile: false, isSymlink: false };
    return {};
  });
  const post: PostContext = {
    postId: "123", canonicalUrl: "https://x.com/a/status/123", authorDisplayName: "A", authorHandle: "@a",
    text: "Idea", mediaUrls: [], outboundUrls: [], capturedAt: "2026-08-05T12:00:00.000Z",
  };

  await expect(prepareProject(
    { request } as unknown as CodexClient,
    { platformOs: "windows" },
    post,
    "C:\\Weaver",
    "C:\\Weaver\\idea-123",
  )).resolves.toMatchObject({ projectPath: "C:\\Weaver\\idea-123" });
  expect(request).toHaveBeenCalledWith("fs/writeFile", expect.objectContaining({
    path: "C:\\Weaver\\idea-123\\.weaver-project.json",
  }));
});

it.each([
  {
    name: "regular file",
    entry: { fileName: "idea-123", isDirectory: false, isFile: true },
    metadata: undefined,
  },
  {
    name: "symbolic link",
    entry: { fileName: "idea-123", isDirectory: true, isFile: false },
    metadata: { isDirectory: true, isFile: false, isSymlink: true },
  },
])("rejects a persisted project path occupied by a $name", async ({ entry, metadata }) => {
  const request = vi.fn(async (method: string) => {
    if (method === "command/exec") return { exitCode: 0, stdout: "C:\\Users\\me\r\n", stderr: "" };
    if (method === "fs/readDirectory") return { entries: [entry] };
    if (method === "fs/getMetadata") return metadata;
    return {};
  });
  const post: PostContext = {
    postId: "123", canonicalUrl: "https://x.com/a/status/123", authorDisplayName: "A", authorHandle: "@a",
    text: "Idea", mediaUrls: [], outboundUrls: [], capturedAt: "2026-08-05T12:00:00.000Z",
  };

  await expect(prepareProject(
    { request } as unknown as CodexClient,
    { platformOs: "windows" },
    post,
    "C:\\Weaver",
    "C:\\Weaver\\idea-123",
  )).rejects.toThrow(/not a (safe )?directory/);
});
