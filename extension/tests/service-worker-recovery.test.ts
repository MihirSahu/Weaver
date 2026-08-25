import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeRequest, RuntimeResponse } from "../src/shared/messages";
import type { PostContext, WeaverBuild, WeaverSettings } from "../src/shared/models";

type MessageListener = (
  message: RuntimeRequest,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: RuntimeResponse) => void,
) => boolean;

const settings: WeaverSettings = {
  endpoint: "ws://127.0.0.1:4500",
  projectRoot: "C:\\Weaver",
  openOnCompletion: true,
};

const post: PostContext = {
  postId: "123",
  canonicalUrl: "https://x.com/a/status/123",
  authorDisplayName: "A",
  authorHandle: "@a",
  text: "Build this",
  mediaUrls: [],
  outboundUrls: [],
  capturedAt: "2026-08-05T00:00:00.000Z",
};

function build(patch: Partial<WeaverBuild> = {}): WeaverBuild {
  return {
    postId: "123",
    postUrl: post.canonicalUrl,
    projectName: "build-this-123",
    projectPath: "C:\\Weaver\\build-this-123",
    threadId: "thread-123",
    turnId: "turn-123",
    status: "building",
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z",
    ...patch,
  };
}

async function loadWorker(options: {
  record: WeaverBuild | undefined;
  startupBuilds?: WeaverBuild[];
  projectWasExisting?: boolean;
  recoveredThreadId?: string;
  getSettings?: () => Promise<WeaverSettings>;
  openThread?: (threadId: string) => Promise<void>;
  request: (method: string, params: unknown) => Promise<unknown>;
}) {
  vi.resetModules();
  let record = options.record;
  let messageListener: MessageListener | undefined;
  let notificationListener: ((notification: { method: string; params?: unknown }) => void) | undefined;
  let disconnectListener: (() => void) | undefined;
  const openThread = vi.fn(options.openThread ?? (async () => undefined));
  const recordedProjectThreads: string[] = [];
  const saveBuild = vi.fn(async (next: WeaverBuild) => {
    record = next;
    return next;
  });

  Object.assign(globalThis, {
    chrome: {
      runtime: {
        id: "abcdefghijklmnopabcdefghijklmnop",
        onMessage: { addListener: vi.fn((listener: MessageListener) => { messageListener = listener; }) },
        onStartup: { addListener: vi.fn() },
      },
      storage: { local: {} },
    },
  });

  vi.doMock("../src/shared/storage", () => ({
    findBuild: vi.fn(async () => record),
    findBuildByThread: vi.fn(async () => record),
    getBuilds: vi.fn(async () => options.startupBuilds?.map((candidate) =>
      candidate.postId === record?.postId ? record : candidate
    ).filter((candidate): candidate is WeaverBuild => Boolean(candidate)) ?? []),
    getSettings: vi.fn(options.getSettings ?? (async () => settings)),
    saveBuild,
    saveSettings: vi.fn(async () => undefined),
    updateSettings: vi.fn(async (update: (current: WeaverSettings) => WeaverSettings) => update(settings)),
    transitionBuild: (current: WeaverBuild, status: WeaverBuild["status"], patch: Partial<WeaverBuild> = {}) => ({
      ...current,
      ...patch,
      status,
      updatedAt: "2026-08-05T00:01:00.000Z",
    }),
  }));
  vi.doMock("../src/background/handoff", () => ({ openThread }));
  vi.doMock("../src/background/project-manager", () => ({
    createThreadTitle: () => "Build: Build this",
    createWorkspacePolicy: (projectPath: string) => ({ type: "workspaceWrite", writableRoots: [projectPath] }),
    prepareProject: async (
      _client: unknown,
      _platform: unknown,
      _post: PostContext,
      _projectRoot: string | null,
      _existingProjectPath: string | undefined,
      onPlanned: (project: { projectRoot: string; projectName: string; projectPath: string }) => Promise<void>,
    ) => {
      const project = {
        projectRoot: "C:\\Weaver",
        projectName: "build-this-123",
        projectPath: "C:\\Weaver\\build-this-123",
        wasExisting: options.projectWasExisting ?? false,
        recoveredThreadId: options.recoveredThreadId,
      };
      await onPlanned(project);
      return project;
    },
    recordProjectThread: vi.fn(async (_client: unknown, _platform: unknown, _project: unknown, _post: unknown, threadId: string) => {
      recordedProjectThreads.push(threadId);
    }),
  }));
  vi.doMock("../src/background/codex-client", () => ({
    CodexClient: class {
      readonly endpoint: string;
      constructor(endpoint: string) { this.endpoint = endpoint; }
      onNotification(listener: (notification: { method: string; params?: unknown }) => void): () => void {
        notificationListener = listener;
        return () => undefined;
      }
      onDisconnect(listener: () => void): () => void {
        disconnectListener = listener;
        return () => undefined;
      }
      async connect() { return { platformOs: "windows" }; }
      request(method: string, params: unknown) { return options.request(method, params); }
      close(): void {}
    },
  }));

  await import("../src/background/service-worker");
  return {
    getRecord: () => record,
    getMessageListener: () => messageListener,
    openThread,
    recordedProjectThreads,
    saveBuild,
    emitNotification: (notification: { method: string; params?: unknown }) => notificationListener?.(notification),
    emitDisconnect: () => disconnectListener?.(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("service-worker persisted build recovery", () => {
  it("opens the idle task before asking Desktop to start its turn", async () => {
    const methods: string[] = [];
    let releaseTurn: ((result: unknown) => void) | undefined;
    const turnStarted = new Promise<unknown>((resolve) => { releaseTurn = resolve; });
    const harness = await loadWorker({
      record: undefined,
      request: async (method) => {
        methods.push(method);
        if (method === "thread/start") return { thread: { id: "thread-123" } };
        if (method === "weaver/desktop-turn/start") return turnStarted;
        return {};
      },
    });
    const listener = harness.getMessageListener()!;
    const response = new Promise<RuntimeResponse>((resolve) => {
      listener({ type: "WEAVE_POST", post }, { url: "https://x.com/home" }, resolve);
    });

    await vi.waitFor(() => expect(methods).toContain("weaver/desktop-turn/start"));
    expect(harness.openThread).toHaveBeenCalledTimes(1);
    expect(harness.openThread).toHaveBeenCalledWith("thread-123");
    releaseTurn!({ turn: { id: "turn-123", status: "inProgress" } });

    await expect(response).resolves.toMatchObject({
      ok: true,
      build: { threadId: "thread-123", turnId: "turn-123", status: "building" },
    });
    expect(harness.openThread).toHaveBeenCalledTimes(1);
    expect(harness.recordedProjectThreads).toEqual(["thread-123"]);

    harness.emitNotification({
      method: "turn/completed",
      params: { threadId: "thread-123", turn: { id: "turn-123", status: "completed" } },
    });
    await vi.waitFor(() => expect(harness.getRecord()).toMatchObject({ status: "ready" }));
    expect(harness.openThread).toHaveBeenCalledTimes(1);
    expect(harness.openThread).toHaveBeenCalledWith("thread-123");
  });

  it("still opens Desktop before execution when completion handoff is disabled", async () => {
    const harness = await loadWorker({
      record: undefined,
      getSettings: async () => ({ ...settings, openOnCompletion: false }),
      request: async (method) => {
        if (method === "thread/start") return { thread: { id: "thread-123" } };
        if (method === "weaver/desktop-turn/start") return { turn: { id: "turn-123", status: "inProgress" } };
        return {};
      },
    });
    const listener = harness.getMessageListener()!;

    await new Promise<RuntimeResponse>((resolve) => {
      listener({ type: "WEAVE_POST", post }, { url: "https://x.com/home" }, resolve);
    });

    harness.emitNotification({
      method: "turn/completed",
      params: { threadId: "thread-123", turn: { id: "turn-123", status: "completed" } },
    });
    await vi.waitFor(() => expect(harness.getRecord()).toMatchObject({ status: "ready" }));
    expect(harness.openThread).toHaveBeenCalledTimes(1);
    expect(harness.openThread).toHaveBeenCalledWith("thread-123");
  });

  it("does not start a turn when opening the task in Desktop fails", async () => {
    const methods: string[] = [];
    const harness = await loadWorker({
      record: undefined,
      openThread: async () => { throw new Error("Desktop is unavailable"); },
      request: async (method) => {
        methods.push(method);
        if (method === "thread/start") return { thread: { id: "thread-123" } };
        return {};
      },
    });
    const listener = harness.getMessageListener()!;

    const response = await new Promise<RuntimeResponse>((resolve) => {
      listener({ type: "WEAVE_POST", post }, { url: "https://x.com/home" }, resolve);
    });

    expect(response).toMatchObject({ ok: false, error: expect.stringContaining("Desktop handoff failed") });
    expect(harness.getRecord()).toMatchObject({ status: "submitted", threadId: "thread-123", turnId: undefined });
    expect(methods).not.toContain("weaver/desktop-turn/start");
  });

  it("reports a Desktop ownership timeout without claiming the backend is offline", async () => {
    const harness = await loadWorker({
      record: undefined,
      request: async (method) => {
        if (method === "thread/start") return { thread: { id: "thread-123" } };
        if (method === "weaver/desktop-turn/start") {
          throw new Error("Codex Desktop IPC request timed out: thread-owner-discovery");
        }
        return {};
      },
    });
    const listener = harness.getMessageListener()!;

    const response = await new Promise<RuntimeResponse>((resolve) => {
      listener({ type: "WEAVE_POST", post }, { url: "https://x.com/home" }, resolve);
    });

    expect(response).toMatchObject({
      ok: false,
      error: expect.stringContaining("Codex Desktop handoff failed"),
    });
    expect(response).not.toMatchObject({ error: expect.stringContaining("backend is offline") });
    expect(harness.getRecord()).toMatchObject({ status: "submitted", turnId: undefined });
  });

  it("does not open an already-running turn when the user chooses Weave again", async () => {
    const harness = await loadWorker({
      record: build(),
      request: async (method) => {
        expect(method).toBe("thread/read");
        return { thread: { turns: [{ id: "turn-123", status: "inProgress" }] } };
      },
    });
    const listener = harness.getMessageListener()!;

    const response = await new Promise<RuntimeResponse>((resolve) => {
      listener({ type: "WEAVE_POST", post }, { url: "https://x.com/home" }, resolve);
    });

    expect(response).toMatchObject({ ok: true, build: { status: "building", turnId: "turn-123" } });
    expect(harness.openThread).not.toHaveBeenCalled();
  });

  it("recovers an existing task when the owned project survives but Chrome storage does not", async () => {
    const methods: string[] = [];
    const harness = await loadWorker({
      record: undefined,
      projectWasExisting: true,
      recoveredThreadId: "thread-recovered",
      request: async (method) => {
        methods.push(method);
        if (method === "thread/read") {
          return { thread: { turns: [{ id: "turn-recovered", status: "inProgress" }] } };
        }
        throw new Error(`Unexpected method: ${method}`);
      },
    });
    const listener = harness.getMessageListener()!;

    const response = await new Promise<RuntimeResponse>((resolve) => {
      listener({ type: "WEAVE_POST", post }, { url: "https://x.com/home" }, resolve);
    });

    expect(response).toMatchObject({
      ok: true,
      build: { projectPath: "C:\\Weaver\\build-this-123", threadId: "thread-recovered", turnId: "turn-recovered", status: "building" },
    });
    expect(methods).toEqual(["thread/read"]);
    expect(harness.openThread).not.toHaveBeenCalled();
  });

  it("refuses to guess a task for a legacy marker when Chrome storage is missing", async () => {
    const request = vi.fn(async () => {
      throw new Error("No Codex request should be needed.");
    });
    const harness = await loadWorker({
      record: undefined,
      projectWasExisting: true,
      request,
    });
    const listener = harness.getMessageListener()!;

    const response = await new Promise<RuntimeResponse>((resolve) => {
      listener({ type: "WEAVE_POST", post }, { url: "https://x.com/home" }, resolve);
    });

    expect(response).toMatchObject({ ok: false, error: expect.stringContaining("predates exact task recovery") });
    expect(request).not.toHaveBeenCalled();
    expect(harness.openThread).not.toHaveBeenCalled();
  });

  it("keeps a build non-retryable when thread reconciliation is uncertain", async () => {
    const methods: string[] = [];
    const harness = await loadWorker({
      record: build(),
      request: async (method) => {
        methods.push(method);
        throw new Error("Codex request timed out: thread/read");
      },
    });
    const listener = harness.getMessageListener();
    expect(listener).toBeTypeOf("function");

    const response = await new Promise<RuntimeResponse>((resolve) => {
      expect(listener!({ type: "WEAVE_POST", post }, { url: "https://x.com/home" }, resolve)).toBe(true);
    });

    expect(response).toMatchObject({ ok: false, error: expect.stringContaining("Weaver backend is offline") });
    expect(harness.getRecord()).toMatchObject({ status: "building", turnId: "turn-123" });
    expect(harness.saveBuild).toHaveBeenCalledWith(expect.objectContaining({ status: "building" }));
    expect(methods).toEqual(["thread/read"]);
  });

  it("reconciles and hands off completed builds as soon as the worker starts", async () => {
    const initial = build();
    const harness = await loadWorker({
      record: initial,
      startupBuilds: [initial],
      request: async (method) => {
        expect(method).toBe("thread/read");
        return { thread: { turns: [{ id: "turn-123", status: "completed" }] } };
      },
    });

    await vi.waitFor(() => {
      expect(harness.getRecord()).toMatchObject({ status: "ready", turnId: "turn-123" });
      expect(harness.openThread).toHaveBeenCalledWith("thread-123");
    });
  });

  it("does not hand off twice when completion wins a startup reconciliation race", async () => {
    const initial = build();
    let releaseResume: ((result: unknown) => void) | undefined;
    const resume = new Promise<unknown>((resolve) => { releaseResume = resolve; });
    const harness = await loadWorker({
      record: initial,
      startupBuilds: [initial],
      request: async (method) => {
        expect(method).toBe("thread/read");
        return resume;
      },
    });

    harness.emitNotification({
      method: "turn/completed",
      params: { threadId: "thread-123", turn: { id: "turn-123", status: "completed" } },
    });
    await vi.waitFor(() => {
      expect(harness.getRecord()).toMatchObject({ status: "ready" });
      expect(harness.openThread).toHaveBeenCalledTimes(1);
    });

    releaseResume!({ thread: { turns: [{ id: "turn-123", status: "completed" }] } });
    await new Promise((resolveMutation) => setTimeout(resolveMutation, 0));

    expect(harness.openThread).toHaveBeenCalledTimes(1);
  });

  it("does not hand off twice when a click shares startup reconciliation", async () => {
    const initial = build();
    let releaseResume: ((result: unknown) => void) | undefined;
    let releaseStartupSettings: ((value: WeaverSettings) => void) | undefined;
    let resumeRequested = false;
    let settingsReadCount = 0;
    const resume = new Promise<unknown>((resolve) => { releaseResume = resolve; });
    const delayedSettings = new Promise<WeaverSettings>((resolve) => { releaseStartupSettings = resolve; });
    const harness = await loadWorker({
      record: initial,
      startupBuilds: [initial],
      getSettings: async () => {
        settingsReadCount += 1;
        return settingsReadCount === 2 ? delayedSettings : settings;
      },
      request: async (method) => {
        expect(method).toBe("thread/read");
        resumeRequested = true;
        return resume;
      },
    });
    await vi.waitFor(() => expect(resumeRequested).toBe(true));

    const listener = harness.getMessageListener()!;
    const response = new Promise<RuntimeResponse>((resolve) => {
      listener({ type: "WEAVE_POST", post }, { url: "https://x.com/home" }, resolve);
    });
    releaseResume!({ thread: { turns: [{ id: "turn-123", status: "completed" }] } });

    await expect(response).resolves.toMatchObject({ ok: true, build: { status: "ready" } });
    expect(harness.openThread).toHaveBeenCalledTimes(1);

    releaseStartupSettings!(settings);
    await new Promise((resolveMutation) => setTimeout(resolveMutation, 0));
    expect(harness.openThread).toHaveBeenCalledTimes(1);
  });

  it("ignores repeated completion delivery for an already terminal turn", async () => {
    const initial = build({ status: "ready" });
    const harness = await loadWorker({
      record: initial,
      request: async () => ({ thread: { turns: [] } }),
    });

    harness.emitNotification({
      method: "turn/completed",
      params: { threadId: "thread-123", turn: { id: "turn-123", status: "completed" } },
    });
    await new Promise((resolveMutation) => setTimeout(resolveMutation, 0));

    expect(harness.getRecord()).toBe(initial);
    expect(harness.saveBuild).not.toHaveBeenCalled();
    expect(harness.openThread).not.toHaveBeenCalled();
  });

  it("retries reconciliation when an unknown persisted turn later completes", async () => {
    const initial = build({ status: "submitted", turnId: undefined });
    let readCount = 0;
    const harness = await loadWorker({
      record: initial,
      startupBuilds: [initial],
      request: async (method) => {
        expect(method).toBe("thread/read");
        readCount += 1;
        if (readCount === 1) throw new Error("Codex request timed out: thread/read");
        return { thread: { turns: [{ id: "turn-recovered", status: "completed" }] } };
      },
    });
    await vi.waitFor(() => {
      expect(harness.saveBuild).toHaveBeenCalledWith(expect.objectContaining({
        status: "submitted",
        turnId: undefined,
        errorSummary: expect.stringContaining("Weaver backend is offline"),
      }));
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    harness.emitNotification({
      method: "turn/completed",
      params: { threadId: "thread-123", turn: { id: "turn-recovered", status: "completed" } },
    });

    await vi.waitFor(() => {
      expect(readCount).toBe(2);
      expect(harness.getRecord()).toMatchObject({ status: "ready", turnId: "turn-recovered" });
      expect(harness.openThread).toHaveBeenCalledWith("thread-123");
    });
  });

  it("retries the startup sweep after a transient reconciliation failure", async () => {
    const initial = build();
    let resumeCount = 0;
    const harness = await loadWorker({
      record: initial,
      startupBuilds: [initial],
      request: async (method) => {
        if (method !== "thread/read") return {};
        resumeCount += 1;
        if (resumeCount === 1) throw new Error("Codex request timed out: thread/read");
        return { thread: { turns: [{ id: "turn-123", status: "completed" }] } };
      },
    });
    await vi.waitFor(() => {
      expect(harness.getRecord()).toMatchObject({
        status: "building",
        errorSummary: expect.stringContaining("Weaver backend is offline"),
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const listener = harness.getMessageListener()!;
    await new Promise<RuntimeResponse>((resolve) => {
      listener({ type: "GET_SETUP_STATE" }, {}, resolve);
    });

    await vi.waitFor(() => {
      expect(resumeCount).toBe(2);
      expect(harness.getRecord()).toMatchObject({ status: "ready", turnId: "turn-123" });
      expect(harness.openThread).toHaveBeenCalledWith("thread-123");
    });
  });

  it("re-reads an active Desktop build after the backend socket disconnects", async () => {
    const initial = build();
    let resumeCount = 0;
    const harness = await loadWorker({
      record: initial,
      startupBuilds: [initial],
      request: async (method) => {
        if (method !== "thread/read") return {};
        resumeCount += 1;
        return { thread: { turns: [{
          id: "turn-123",
          status: resumeCount === 1 ? "inProgress" : "completed",
        }] } };
      },
    });
    await vi.waitFor(() => expect(resumeCount).toBe(1));

    harness.emitDisconnect();

    await vi.waitFor(() => {
      expect(resumeCount).toBe(2);
      expect(harness.getRecord()).toMatchObject({ status: "ready", turnId: "turn-123" });
      expect(harness.openThread).toHaveBeenCalledWith("thread-123");
    });
  });

  it("preserves endpoint validation errors instead of reporting Codex offline", async () => {
    const harness = await loadWorker({
      record: build({ status: "ready" }),
      request: async () => ({}),
    });
    const listener = harness.getMessageListener()!;

    const response = await new Promise<RuntimeResponse>((resolve) => {
      listener({
        type: "SAVE_SETTINGS",
        changes: { endpoint: "http://127.0.0.1:4500" },
      }, {}, resolve);
    });

    expect(response).toEqual({
      ok: false,
      error: "Weaver only connects with ws:// on loopback.",
    });
  });
});
