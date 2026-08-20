import { appServerStartCommand, DEFAULT_ENDPOINT } from "../shared/constants";
import type { RuntimeRequest, RuntimeResponse } from "../shared/messages";
import type { PostContext, WeaverBuild } from "../shared/models";
import { createBuildInput } from "../shared/prompt";
import { findBuild, findBuildByThread, getBuilds, getSettings, saveBuild, transitionBuild, updateSettings } from "../shared/storage";
import { isPostContext, isTrustedXSender, requiresClientReconnect, validateSettings } from "../shared/validation";
import { CodexClient, type InitializeResult, type RpcNotification } from "./codex-client";
import { openThread } from "./handoff";
import { createThreadTitle, createWorkspacePolicy, prepareProject } from "./project-manager";
import {
  decideBuildReconciliation,
  isStaleReconciliationSnapshot,
  isTerminalBuildForTurn,
  shouldReconcileBeforeSubmit,
  type CodexTurnSnapshot,
} from "./build-recovery";

interface ThreadStartResult { thread: { id: string } }
interface ThreadListResult { data: Array<{ id: string; cwd: string; preview: string }> }
interface TurnStartResult { turn: { id: string; status: string } }
interface ThreadResumeResult { thread: { turns: CodexTurnSnapshot[] } }
interface TurnCompletedParams { threadId: string; turn: CodexTurnSnapshot }
interface ReconciliationResult { build: WeaverBuild; transitionedToReady: boolean }

let client: CodexClient | null = null;
let platform: InitializeResult | null = null;
const inFlight = new Map<string, Promise<WeaverBuild>>();
const reconciliationInFlight = new Map<string, Promise<ReconciliationResult>>();
const buildMutationQueues = new Map<string, Promise<unknown>>();
const pendingTurnCompletions = new Map<string, TurnCompletedParams>();
const handoffsInFlight = new Map<string, Promise<void>>();
const completedAutomaticHandoffs = new Set<string>();
let startupSweep: Promise<void> | null = null;
let startupSweepCompleted = false;
let startupSweepRerunRequested = false;

class ReconciliationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconciliationUnavailableError";
  }
}

function completionKey(threadId: string, turnId: string): string {
  return `${threadId}:${turnId}`;
}

function rememberPendingCompletion(params: TurnCompletedParams): void {
  pendingTurnCompletions.set(completionKey(params.threadId, params.turn.id), params);
  if (pendingTurnCompletions.size > 100) {
    const oldest = pendingTurnCompletions.keys().next().value;
    if (oldest) pendingTurnCompletions.delete(oldest);
  }
}

async function openThreadOnce(threadId: string): Promise<void> {
  const current = handoffsInFlight.get(threadId);
  if (current) return current;
  const handoff = openThread(threadId).finally(() => {
    if (handoffsInFlight.get(threadId) === handoff) handoffsInFlight.delete(threadId);
  });
  handoffsInFlight.set(threadId, handoff);
  return handoff;
}

async function automaticallyOpenThreadOnce(threadId: string): Promise<void> {
  if (completedAutomaticHandoffs.has(threadId)) return;
  await openThreadOnce(threadId);
  completedAutomaticHandoffs.add(threadId);
}

function conciseError(error: unknown, endpoint = client?.endpoint ?? DEFAULT_ENDPOINT): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/app-server (?:is offline|connection is not open|disconnected)|timed out (?:connecting|waiting)|request timed out/i.test(message)) {
    return `Codex app-server is offline. Start it with: ${appServerStartCommand(endpoint)}`;
  }
  return message.slice(0, 300);
}

async function openReconciledBuild(build: WeaverBuild): Promise<void> {
  if ((await getSettings()).openOnCompletion) {
    await automaticallyOpenThreadOnce(build.threadId);
  } else {
    // This path is reached because the user explicitly chose Weave. Even when
    // automatic handoff is disabled, that click should open a recovered task.
    await openThreadOnce(build.threadId);
  }
}

async function getClient(): Promise<CodexClient> {
  const settings = await getSettings();
  if (!client || client.endpoint !== settings.endpoint) {
    client?.close();
    client = new CodexClient(settings.endpoint);
    client.onNotification((notification) => { void handleNotification(notification); });
    client.onDisconnect(() => {
      platform = null;
      requestReconciliationSweep();
    });
  }
  const selected = client;
  const initialized = await selected.connect();
  if (client !== selected) {
    selected.close();
    return getClient();
  }
  platform = initialized;
  return selected;
}

async function withBuildMutation<T>(postId: string, operation: () => Promise<T>): Promise<T> {
  const previous = buildMutationQueues.get(postId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  buildMutationQueues.set(postId, current);
  try {
    return await current;
  } finally {
    if (buildMutationQueues.get(postId) === current) buildMutationQueues.delete(postId);
  }
}

async function reconcileBuildOnce(build: WeaverBuild): Promise<ReconciliationResult> {
  if (!build.threadId) {
    const updated = await withBuildMutation(build.postId, async () => {
      const latest = await findBuild(build.postId);
      if (!latest || isStaleReconciliationSnapshot(build, latest)) return latest ?? build;
      return saveBuild(transitionBuild(latest, "failed", {
        errorSummary: "Build setup was interrupted before Codex created a task. Choose Weave again to continue.",
      }));
    });
    return { build: updated, transitionedToReady: false };
  }
  try {
    const codex = await getClient();
    // `thread/read` only returns persisted state. Resuming is required to
    // subscribe this replacement service-worker connection to turn events.
    const result = await codex.request<ThreadResumeResult>("thread/resume", {
      threadId: build.threadId,
      cwd: build.projectPath,
      runtimeWorkspaceRoots: [build.projectPath],
      approvalPolicy: "never",
      sandbox: "workspace-write",
    });
    let transitionedToReady = false;
    const updated = await withBuildMutation(build.postId, async () => {
      const latest = await findBuild(build.postId);
      if (!latest || isStaleReconciliationSnapshot(build, latest)) return latest ?? build;
      const decision = decideBuildReconciliation(latest, result.thread.turns);
      if (latest.status === decision.status && latest.turnId === decision.turnId && latest.errorSummary === decision.errorSummary) return latest;
      transitionedToReady = latest.status !== "ready" && decision.status === "ready";
      return saveBuild(transitionBuild(latest, decision.status, {
        turnId: decision.turnId,
        errorSummary: decision.errorSummary,
      }));
    });
    return { build: updated, transitionedToReady };
  } catch (error) {
    const errorSummary = conciseError(error);
    let superseded = false;
    const preserved = await withBuildMutation(build.postId, async () => {
      const latest = await findBuild(build.postId);
      if (!latest || isStaleReconciliationSnapshot(build, latest)) {
        superseded = true;
        return latest ?? build;
      }
      if (latest.status === "failed") return latest;
      return saveBuild(transitionBuild(latest, latest.status, { errorSummary }));
    });
    if (superseded) return { build: preserved, transitionedToReady: false };
    throw new ReconciliationUnavailableError(errorSummary);
  }
}

async function reconcileBuild(build: WeaverBuild): Promise<ReconciliationResult> {
  const current = reconciliationInFlight.get(build.postId);
  if (current) return current;
  const promise = reconcileBuildOnce(build).finally(() => reconciliationInFlight.delete(build.postId));
  reconciliationInFlight.set(build.postId, promise);
  return promise;
}

async function handleNotification(notification: RpcNotification): Promise<void> {
  if (notification.method !== "turn/completed") return;
  const params = notification.params as TurnCompletedParams;
  const build = await findBuildByThread(params.threadId);
  if (!build) return;
  if (!build.turnId && build.status === "submitted") {
    if (inFlight.has(build.postId)) {
      rememberPendingCompletion(params);
      return;
    }
    const reconciliation = await reconcileBuild(build).catch(() => undefined);
    if (reconciliation?.transitionedToReady && (await getSettings()).openOnCompletion) {
      await automaticallyOpenThreadOnce(reconciliation.build.threadId).catch(() => undefined);
    }
    return;
  }
  if (build.turnId !== params.turn.id) return;
  const succeeded = params.turn.status === "completed";
  const updated = await withBuildMutation(build.postId, async () => {
    const latest = await findBuild(build.postId);
    if (!latest || latest.threadId !== params.threadId || latest.turnId !== params.turn.id) return undefined;
    if (isTerminalBuildForTurn(latest, params.threadId, params.turn.id)) return undefined;
    return saveBuild(transitionBuild(latest, succeeded ? "ready" : "failed", {
      turnId: params.turn.id,
      ...(succeeded ? { errorSummary: undefined } : { errorSummary: params.turn.error?.message ?? `Codex turn ${params.turn.status}.` }),
    }));
  });
  if (!updated) return;
  if (succeeded && (await getSettings()).openOnCompletion) {
    // Opening Desktop is a handoff convenience. A protocol-handler failure does
    // not change the fact that the build completed successfully.
    await automaticallyOpenThreadOnce(updated.threadId).catch(() => undefined);
  }
}

async function beginBuild(post: PostContext): Promise<WeaverBuild> {
  let existing = await findBuild(post.postId);
  if (existing?.status === "ready") {
    await openThreadOnce(existing.threadId);
    return existing;
  }
  if (existing && shouldReconcileBeforeSubmit(existing)) {
    existing = (await reconcileBuild(existing)).build;
    if (existing.status === "ready") {
      await openReconciledBuild(existing);
      return existing;
    }
    if (existing.status !== "failed") return existing;
  }

  const codex = await getClient();
  if (!platform) throw new Error("Codex platform information is unavailable.");
  const settings = await getSettings();
  const now = new Date().toISOString();
  let build: WeaverBuild | undefined = existing;
  const project = await prepareProject(codex, platform, post, settings.projectRoot, existing?.projectPath || undefined, async (planned) => {
    build = await withBuildMutation(post.postId, () => saveBuild({
        postId: post.postId,
        postUrl: post.canonicalUrl,
        projectName: planned.projectName,
        projectPath: planned.projectPath,
        threadId: existing?.threadId ?? "",
        status: "submitted",
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }),
    );
  });
  if (!build) throw new Error("Weaver could not persist the planned project.");
  if (!settings.projectRoot) {
    await updateSettings((current) => current.projectRoot ? current : { ...current, projectRoot: project.projectRoot });
  }

  let threadId = build.threadId;
  if (!threadId && existing) {
    const listed = await codex.request<ThreadListResult>("thread/list", {
      cwd: project.projectPath,
      limit: 10,
      sortKey: "created_at",
      sortDirection: "desc",
      sourceKinds: ["appServer"],
    });
    // If thread/start succeeded but its response was lost, the recoverable
    // thread has no user turn yet. Never adopt a populated task from this cwd.
    threadId = listed.data.find((candidate) => candidate.preview.trim() === "")?.id ?? "";
    if (threadId) {
      build = await withBuildMutation(post.postId, () => saveBuild(
        transitionBuild(build!, "submitted", { threadId, turnId: undefined, errorSummary: undefined }),
      ));
      const recovered = (await reconcileBuild(build)).build;
      if (recovered.status === "ready") {
        await openReconciledBuild(recovered);
        return recovered;
      }
      if (recovered.status === "building") return recovered;
      build = recovered;
    }
  }
  if (threadId) {
    await codex.request("thread/resume", { threadId, cwd: project.projectPath, approvalPolicy: "never", sandbox: "workspace-write" });
  } else {
    const started = await codex.request<ThreadStartResult>("thread/start", {
      cwd: project.projectPath,
      runtimeWorkspaceRoots: [project.projectPath],
      approvalPolicy: "never",
      sandbox: "workspace-write",
      serviceName: "weaver",
    });
    threadId = started.thread.id;
  }
  build = await withBuildMutation(post.postId, () => saveBuild(
    transitionBuild(build!, "submitted", { threadId, turnId: undefined, errorSummary: undefined }),
  ));

  await codex.request("thread/name/set", { threadId, name: createThreadTitle(post) });
  const turn = await codex.request<TurnStartResult>("turn/start", {
    threadId,
    input: [createBuildInput(post)],
    cwd: project.projectPath,
    runtimeWorkspaceRoots: [project.projectPath],
    approvalPolicy: "never",
    sandboxPolicy: createWorkspacePolicy(project.projectPath),
  });
  let consumedCompletion = false;
  build = await withBuildMutation(post.postId, async () => {
    const latest = await findBuild(post.postId);
    if (isTerminalBuildForTurn(latest, threadId, turn.turn.id)) return latest!;
    const completion = pendingTurnCompletions.get(completionKey(threadId, turn.turn.id));
    pendingTurnCompletions.delete(completionKey(threadId, turn.turn.id));
    if (completion) {
      consumedCompletion = true;
      const succeeded = completion.turn.status === "completed";
      return saveBuild(transitionBuild(latest ?? build!, succeeded ? "ready" : "failed", {
        threadId,
        turnId: turn.turn.id,
        ...(succeeded
          ? { errorSummary: undefined }
          : { errorSummary: completion.turn.error?.message ?? `Codex turn ${completion.turn.status}.` }),
      }));
    }
    return saveBuild(transitionBuild(build!, "building", { turnId: turn.turn.id, errorSummary: undefined }));
  });
  if (consumedCompletion && build.status === "ready" && (await getSettings()).openOnCompletion) {
    await automaticallyOpenThreadOnce(build.threadId);
  }
  return build;
}

async function weave(post: PostContext): Promise<WeaverBuild> {
  const current = inFlight.get(post.postId);
  if (current) return current;
  const promise = beginBuild(post).catch(async (error) => {
    if (error instanceof ReconciliationUnavailableError) throw error;
    const previous = await findBuild(post.postId);
    if (!previous) throw error;
    if (previous.status === "ready") throw error;
    if (previous.threadId && !previous.turnId) {
      const recovered = (await reconcileBuild(previous)).build;
      if (recovered.status === "ready") await openReconciledBuild(recovered);
      return recovered;
    }
    return withBuildMutation(post.postId, async () => {
      const latest = await findBuild(post.postId);
      if (!latest || latest.status === "ready") return latest ?? previous;
      return saveBuild(transitionBuild(latest, "failed", { errorSummary: conciseError(error) }));
    });
  }).finally(() => inFlight.delete(post.postId));
  inFlight.set(post.postId, promise);
  return promise;
}

async function reconcilePersistedBuilds(): Promise<void> {
  const builds = (await getBuilds()).filter((build) => build.status === "submitted" || build.status === "building");
  const results = await Promise.allSettled(builds.map(async (build) => {
    const reconciliation = await reconcileBuild(build);
    if (reconciliation.transitionedToReady && (await getSettings()).openOnCompletion) {
      await automaticallyOpenThreadOnce(reconciliation.build.threadId);
    }
  }));
  const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure) throw failure.reason;
}

function startStartupReconciliation(): void {
  if (startupSweepCompleted || startupSweep) return;
  const sweep = reconcilePersistedBuilds();
  startupSweep = sweep;
  void sweep.then(
    () => {
      if (startupSweep === sweep) {
        startupSweep = null;
        if (startupSweepRerunRequested) {
          startupSweepRerunRequested = false;
          startStartupReconciliation();
        } else {
          startupSweepCompleted = true;
        }
      }
    },
    () => {
      if (startupSweep === sweep) {
        startupSweep = null;
        if (startupSweepRerunRequested) {
          startupSweepRerunRequested = false;
          startStartupReconciliation();
        }
      }
    },
  );
}

function requestReconciliationSweep(): void {
  startupSweepCompleted = false;
  if (startupSweep) {
    startupSweepRerunRequested = true;
    return;
  }
  startStartupReconciliation();
}

async function handleRequest(message: RuntimeRequest, sender: chrome.runtime.MessageSender): Promise<RuntimeResponse> {
  startStartupReconciliation();
  try {
    switch (message.type) {
      case "WEAVE_POST": {
        if (!isTrustedXSender(sender.url) || !isPostContext(message.post)) return { ok: false, error: "Rejected an invalid X post request." };
        const build = await weave(message.post);
        return build.status === "failed" ? { ok: false, error: build.errorSummary ?? "Build failed.", build } : { ok: true, build };
      }
      case "GET_SETUP_STATE": {
        const settings = await getSettings();
        let connection: { status: "online" | "offline"; endpoint: string; protocolVersion?: string; errorSummary?: string };
        try {
          await getClient();
          const info = platform ?? {};
          connection = { status: "online", endpoint: settings.endpoint, protocolVersion: info.protocolVersion ?? info.userAgent };
        } catch (error) {
          connection = { status: "offline", endpoint: settings.endpoint, errorSummary: conciseError(error, settings.endpoint) };
        }
        return { ok: true, settings, connection };
      }
      case "CHECK_CONNECTION": {
        const settings = await getSettings();
        try {
          await getClient();
          const info = platform ?? {};
          return { ok: true, connection: { status: "online", endpoint: settings.endpoint, protocolVersion: info.protocolVersion ?? info.userAgent } };
        } catch (error) {
          const errorSummary = conciseError(error, settings.endpoint);
          return { ok: false, error: errorSummary, connection: { status: "offline", endpoint: settings.endpoint, errorSummary } };
        }
      }
      case "SAVE_SETTINGS": {
        let reconnect = false;
        const settings = await updateSettings((current) => {
          const next = validateSettings({ ...current, ...message.changes });
          reconnect = requiresClientReconnect(current, next);
          return next;
        });
        if (reconnect) {
          client?.close();
          client = null;
          platform = null;
          requestReconciliationSweep();
        }
        return { ok: true, settings };
      }
    }
  } catch (error) {
    return { ok: false, error: conciseError(error) };
  }
}

chrome.runtime.onMessage.addListener((message: RuntimeRequest, sender, sendResponse: (response: RuntimeResponse) => void) => {
  void handleRequest(message, sender).then(sendResponse);
  return true;
});

chrome.runtime.onStartup.addListener(startStartupReconciliation);
startStartupReconciliation();
