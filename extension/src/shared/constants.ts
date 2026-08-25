import type { WeaverSettings } from "./models";

export const DEFAULT_ENDPOINT = "ws://127.0.0.1:4500";
export const DESKTOP_TURN_START_METHOD = "weaver/desktop-turn/start";
export function backendStartCommand(extensionId: string, endpoint: string): string {
  if (!/^[a-p]{32}$/.test(extensionId)) throw new Error("Invalid Chrome extension ID.");
  const parsed = new URL(endpoint);
  if (!parsed.port || !/^\d+$/.test(parsed.port)) throw new Error("Invalid Weaver backend endpoint.");
  return `sfw pnpm backend --extension-id ${extensionId} --port ${parsed.port}`;
}
export const BUILD_STORAGE_PREFIX = "weaverBuild:";
export const THREAD_STORAGE_PREFIX = "weaverThread:";
export const STORAGE_KEYS = {
  // Kept only so existing development installs can migrate their old build list.
  builds: "weaverBuilds",
  settings: "weaverSettings",
} as const;

export const DEFAULT_SETTINGS: WeaverSettings = {
  endpoint: DEFAULT_ENDPOINT,
  projectRoot: null,
  openOnCompletion: true,
};
