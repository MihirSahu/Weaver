import { describe, expect, it } from "vitest";
import { isPostContext, normalizeStatusUrl, requiresClientReconnect, validateLoopbackEndpoint, validateSettings } from "../src/shared/validation";
import { backendStartCommand } from "../src/shared/constants";

describe("loopback endpoint validation", () => {
  it.each(["ws://127.0.0.1:4500", "ws://localhost:9999"])("accepts %s", (endpoint) => {
    expect(validateLoopbackEndpoint(endpoint)).toBe(endpoint);
  });

  it.each(["wss://127.0.0.1:4500", "ws://[::1]:4500", "ws://192.168.1.2:4500", "ws://example.com:4500", "ws://127.0.0.1"])("rejects %s", (endpoint) => {
    expect(() => validateLoopbackEndpoint(endpoint)).toThrow();
  });
});

it("normalizes X status URLs and strips query data", () => {
  expect(normalizeStatusUrl("https://x.com/thenanyu/status/195123456789?s=20")).toEqual({
    authorHandle: "@thenanyu",
    postId: "195123456789",
    canonicalUrl: "https://x.com/thenanyu/status/195123456789",
  });
});

it("rejects content messages whose post identity and URL disagree with the schema", () => {
  expect(isPostContext({ postId: "oops", canonicalUrl: "https://evil.test", mediaUrls: [], outboundUrls: [] })).toBe(false);
});

it("rejects relative project roots when settings are saved", () => {
  expect(() => validateSettings({ endpoint: "ws://127.0.0.1:4500", projectRoot: "projects", openOnCompletion: true })).toThrow("absolute path");
  expect(validateSettings({ endpoint: "ws://127.0.0.1:4500", projectRoot: "C:\\Projects\\Weaver", openOnCompletion: true }).projectRoot).toBe("C:\\Projects\\Weaver");
});

it("keeps the active client for settings changes that do not change its endpoint", () => {
  const previous = { endpoint: "ws://127.0.0.1:4500", projectRoot: "C:\\One", openOnCompletion: true };
  expect(requiresClientReconnect(previous, { ...previous, projectRoot: "C:\\Two", openOnCompletion: false })).toBe(false);
  expect(requiresClientReconnect(previous, { ...previous, endpoint: "ws://127.0.0.1:4600" })).toBe(true);
});

it("builds backend recovery guidance from the extension ID and configured endpoint", () => {
  expect(backendStartCommand("abcdefghijklmnopabcdefghijklmnop", "ws://127.0.0.1:4600")).toBe(
    "sfw pnpm backend --extension-id abcdefghijklmnopabcdefghijklmnop --port 4600",
  );
});
