import type { WeaverSettings } from "./models";

export const DEFAULT_ENDPOINT = "ws://127.0.0.1:4500";
export function appServerStartCommand(endpoint: string): string {
  return `codex app-server --listen ${endpoint}`;
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
