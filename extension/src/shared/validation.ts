import type { PostContext, QuotedPostContext, WeaverSettings } from "./models";

const STATUS_URL = /^https:\/\/x\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d+)(?:[/?#].*)?$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);
const ABSOLUTE_LOCAL_PATH = /^(?:[A-Za-z]:[\\/]|\/)/;

function isString(value: unknown, maxLength: number, allowEmpty = true): value is string {
  return typeof value === "string" && value.length <= maxLength && (allowEmpty || value.length > 0);
}

function isSafeUrl(value: unknown, protocols = ["https:"]): value is string {
  if (!isString(value, 4096, false)) return false;
  try {
    const parsed = new URL(value);
    return protocols.includes(parsed.protocol);
  } catch {
    return false;
  }
}

function isQuotedPost(value: unknown): value is QuotedPostContext {
  if (!value || typeof value !== "object") return false;
  const quote = value as Record<string, unknown>;
  return (
    isString(quote.text, 20_000) &&
    (quote.canonicalUrl === undefined || isSafeUrl(quote.canonicalUrl)) &&
    (quote.authorHandle === undefined || isString(quote.authorHandle, 32))
  );
}

export function isPostContext(value: unknown): value is PostContext {
  if (!value || typeof value !== "object") return false;
  const post = value as Record<string, unknown>;
  return (
    isString(post.postId, 32, false) && /^\d+$/.test(post.postId) &&
    isString(post.canonicalUrl, 4096, false) && STATUS_URL.test(post.canonicalUrl) &&
    isString(post.authorDisplayName, 256) &&
    isString(post.authorHandle, 32) &&
    isString(post.text, 20_000) &&
    (post.quotedPost === undefined || isQuotedPost(post.quotedPost)) &&
    Array.isArray(post.mediaUrls) && post.mediaUrls.length <= 20 && post.mediaUrls.every((url) => isSafeUrl(url)) &&
    Array.isArray(post.outboundUrls) && post.outboundUrls.length <= 50 && post.outboundUrls.every((url) => isSafeUrl(url)) &&
    isString(post.capturedAt, 64, false) && !Number.isNaN(Date.parse(post.capturedAt))
  );
}

export function normalizeStatusUrl(href: string): { postId: string; canonicalUrl: string; authorHandle: string } | null {
  try {
    const url = new URL(href, "https://x.com");
    if (url.hostname !== "x.com" && url.hostname !== "www.x.com") return null;
    const match = url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/);
    if (!match?.[1] || !match[2]) return null;
    return {
      authorHandle: `@${match[1]}`,
      postId: match[2],
      canonicalUrl: `https://x.com/${match[1]}/status/${match[2]}`,
    };
  } catch {
    return null;
  }
}

export function validateLoopbackEndpoint(endpoint: string): string {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("Enter a valid WebSocket URL.");
  }
  if (parsed.protocol !== "ws:") throw new Error("Weaver only connects with ws:// on loopback.");
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) throw new Error("The Codex endpoint must use 127.0.0.1 or localhost.");
  if (parsed.username || parsed.password) throw new Error("Credentials are not supported in the endpoint URL.");
  if (!parsed.port) throw new Error("The Codex endpoint must include a port.");
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error("The Codex endpoint cannot include a path, query, or fragment.");
  return parsed.toString().replace(/\/$/, "");
}

export function validateSettings(value: unknown): WeaverSettings {
  if (!value || typeof value !== "object") throw new Error("Invalid Weaver settings.");
  const settings = value as Record<string, unknown>;
  const projectRoot = settings.projectRoot === null || settings.projectRoot === "" ? null : settings.projectRoot;
  if (projectRoot !== null && (!isString(projectRoot, 1024, false) || !ABSOLUTE_LOCAL_PATH.test(projectRoot))) {
    throw new Error("Project root must be an absolute path.");
  }
  if (typeof settings.openOnCompletion !== "boolean") throw new Error("Invalid handoff setting.");
  return {
    endpoint: validateLoopbackEndpoint(String(settings.endpoint ?? "")),
    projectRoot,
    openOnCompletion: settings.openOnCompletion,
  };
}

export function requiresClientReconnect(previous: WeaverSettings, next: WeaverSettings): boolean {
  return previous.endpoint !== next.endpoint;
}

export function isTrustedXSender(url?: string): boolean {
  if (!url) return false;
  try {
    return new URL(url).origin === "https://x.com";
  } catch {
    return false;
  }
}
