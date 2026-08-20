import type { ConnectionState, PostContext, WeaverBuild, WeaverSettings } from "./models";

export type RuntimeRequest =
  | { type: "WEAVE_POST"; post: PostContext }
  | { type: "GET_SETUP_STATE" }
  | { type: "CHECK_CONNECTION" }
  | { type: "SAVE_SETTINGS"; changes: Partial<WeaverSettings> };

export type RuntimeResponse =
  | { ok: true; build?: WeaverBuild; settings?: WeaverSettings; connection?: ConnectionState }
  | { ok: false; error: string; build?: WeaverBuild; connection?: ConnectionState };
