import { BUILD_STORAGE_PREFIX, DEFAULT_SETTINGS, STORAGE_KEYS, THREAD_STORAGE_PREFIX } from "./constants";
import type { WeaverBuild, WeaverSettings } from "./models";

let settingsMutationQueue: Promise<void> = Promise.resolve();
const buildMutationQueues = new Map<string, Promise<unknown>>();

function enqueueBuildMutation<T>(postId: string, mutation: () => Promise<T>): Promise<T> {
  const previous = buildMutationQueues.get(postId) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(mutation);
  buildMutationQueues.set(postId, result);
  void result.finally(() => {
    if (buildMutationQueues.get(postId) === result) buildMutationQueues.delete(postId);
  }).catch(() => undefined);
  return result;
}

export function buildStorageKey(postId: string): string {
  return `${BUILD_STORAGE_PREFIX}${postId}`;
}

export function threadStorageKey(threadId: string): string {
  return `${THREAD_STORAGE_PREFIX}${threadId}`;
}

function isBuild(value: unknown): value is WeaverBuild {
  if (!value || typeof value !== "object") return false;
  const build = value as Partial<WeaverBuild>;
  return typeof build.postId === "string" && /^\d+$/.test(build.postId) &&
    typeof build.postUrl === "string" &&
    typeof build.projectName === "string" && build.projectName.length > 0 &&
    typeof build.projectPath === "string" && build.projectPath.length > 0 &&
    typeof build.threadId === "string" &&
    (build.turnId === undefined || typeof build.turnId === "string") &&
    typeof build.status === "string" && ["submitted", "building", "ready", "failed"].includes(build.status) &&
    (build.errorSummary === undefined || typeof build.errorSummary === "string") &&
    typeof build.createdAt === "string" && !Number.isNaN(Date.parse(build.createdAt)) &&
    typeof build.updatedAt === "string" && !Number.isNaN(Date.parse(build.updatedAt));
}

async function readSettings(): Promise<WeaverSettings> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
  const legacy = stored[STORAGE_KEYS.settings] as (Partial<WeaverSettings> & { openOnStart?: unknown }) | undefined;
  return {
    ...DEFAULT_SETTINGS,
    ...legacy,
    openOnCompletion: typeof legacy?.openOnCompletion === "boolean"
      ? legacy.openOnCompletion
      : typeof legacy?.openOnStart === "boolean"
        ? legacy.openOnStart
        : DEFAULT_SETTINGS.openOnCompletion,
  };
}

export async function getSettings(): Promise<WeaverSettings> {
  await settingsMutationQueue;
  return readSettings();
}

function enqueueSettingsMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const result = settingsMutationQueue.catch(() => undefined).then(mutation);
  settingsMutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

export function saveSettings(settings: WeaverSettings): Promise<void> {
  return enqueueSettingsMutation(() => chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings }));
}

export function updateSettings(update: (current: WeaverSettings) => WeaverSettings): Promise<WeaverSettings> {
  return enqueueSettingsMutation(async () => {
    const next = update(await readSettings());
    await chrome.storage.local.set({ [STORAGE_KEYS.settings]: next });
    return next;
  });
}

export async function getBuilds(): Promise<WeaverBuild[]> {
  const stored = await chrome.storage.local.get(null);
  const builds = new Map<string, WeaverBuild>();
  const legacy = stored[STORAGE_KEYS.builds];
  if (Array.isArray(legacy)) {
    for (const candidate of legacy) if (isBuild(candidate)) builds.set(candidate.postId, candidate);
  }
  for (const [key, candidate] of Object.entries(stored)) {
    if (key.startsWith(BUILD_STORAGE_PREFIX) && isBuild(candidate)) builds.set(candidate.postId, candidate);
  }
  return [...builds.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export async function findBuild(postId: string): Promise<WeaverBuild | undefined> {
  const key = buildStorageKey(postId);
  const stored = await chrome.storage.local.get([key, STORAGE_KEYS.builds]);
  const current = stored[key];
  if (isBuild(current)) return current;
  const legacy = stored[STORAGE_KEYS.builds];
  const migrated = Array.isArray(legacy) ? legacy.find((candidate) => isBuild(candidate) && candidate.postId === postId) : undefined;
  if (!isBuild(migrated)) return undefined;
  return enqueueBuildMutation(postId, async () => {
    const latest = (await chrome.storage.local.get(key))[key];
    if (isBuild(latest)) return latest;
    await chrome.storage.local.set({ [key]: migrated });
    return migrated;
  });
}

export async function findBuildByThread(threadId: string): Promise<WeaverBuild | undefined> {
  const indexKey = threadStorageKey(threadId);
  const stored = await chrome.storage.local.get(indexKey);
  const postId = stored[indexKey];
  if (typeof postId === "string") {
    const indexed = await findBuild(postId);
    if (indexed?.threadId === threadId) return indexed;
  }
  return (await getBuilds()).find((build) => build.threadId === threadId);
}

export async function saveBuild(build: WeaverBuild): Promise<WeaverBuild> {
  return enqueueBuildMutation(build.postId, async () => {
    const values: Record<string, unknown> = { [buildStorageKey(build.postId)]: build };
    if (build.threadId) values[threadStorageKey(build.threadId)] = build.postId;
    await chrome.storage.local.set(values);
    return build;
  });
}

export function transitionBuild(build: WeaverBuild, status: WeaverBuild["status"], patch: Partial<WeaverBuild> = {}): WeaverBuild {
  return { ...build, ...patch, status, updatedAt: new Date().toISOString() };
}
