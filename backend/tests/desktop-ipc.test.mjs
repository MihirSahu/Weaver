// @vitest-environment node

import { Duplex } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  DesktopIpcFrameDecoder,
  encodeDesktopIpcFrame,
  startDesktopOwnedTurn,
} from "../desktop-ipc.mjs";

function decodeFrame(frame) {
  const bytes = frame.readUInt32LE(0);
  return JSON.parse(frame.subarray(4, bytes + 4).toString("utf8"));
}

class FakeDesktopSocket extends Duplex {
  constructor(respond) {
    super();
    this.respond = respond;
  }

  _read() {}

  _write(chunk, _encoding, callback) {
    const request = decodeFrame(chunk);
    const response = this.respond(request);
    if (response) this.push(encodeDesktopIpcFrame(response));
    callback();
  }
}

function fakeConnect(respond) {
  return () => {
    const socket = new FakeDesktopSocket(respond);
    queueMicrotask(() => socket.emit("connect"));
    return socket;
  };
}

const turnRequest = {
  threadId: "thread-123",
  input: [{ type: "text", text: "Build this" }],
  cwd: "/tmp/weaver-project",
  runtimeWorkspaceRoots: ["/tmp/weaver-project"],
  approvalPolicy: "never",
  sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/tmp/weaver-project"] },
};

describe("Codex Desktop IPC framing", () => {
  it("decodes messages split across chunks", () => {
    const messages = [];
    const errors = [];
    const decoder = new DesktopIpcFrameDecoder(
      (message) => messages.push(message),
      (error) => errors.push(error),
    );
    const frame = encodeDesktopIpcFrame({ type: "response", requestId: "one" });

    decoder.push(frame.subarray(0, 3));
    decoder.push(frame.subarray(3, 9));
    decoder.push(frame.subarray(9));

    expect(messages).toEqual([{ type: "response", requestId: "one" }]);
    expect(errors).toEqual([]);
  });
});

describe("Codex Desktop ownership handoff", () => {
  it("discovers the Desktop owner before starting exactly one turn", async () => {
    const requests = [];
    const connectImpl = fakeConnect((request) => {
      requests.push(request);
      if (request.method === "initialize") {
        return {
          type: "response",
          requestId: request.requestId,
          resultType: "success",
          method: "initialize",
          result: { clientId: "weaver-client" },
        };
      }
      if (request.method === "thread-owner-discovery") {
        return {
          type: "response",
          requestId: request.requestId,
          resultType: "success",
          method: request.method,
          handledByClientId: "desktop-owner",
          result: {},
        };
      }
      return {
        type: "response",
        requestId: request.requestId,
        resultType: "success",
        method: request.method,
        handledByClientId: "desktop-owner",
        result: { result: { turn: { id: "turn-123", status: "inProgress" } } },
      };
    });

    await expect(startDesktopOwnedTurn({
      threadId: "thread-123",
      turnRequest,
      connectImpl,
      timeoutMs: 1_000,
      logger: { log: vi.fn() },
    })).resolves.toEqual({ turn: { id: "turn-123", status: "inProgress" } });

    expect(requests.map((request) => [request.method, request.version])).toEqual([
      ["initialize", 0],
      ["thread-owner-discovery", 1],
      ["thread-follower-start-turn", 2],
    ]);
    expect(requests[1].params).toEqual({ hostId: "local", conversationId: "thread-123" });
    expect(requests[2]).toMatchObject({
      targetClientId: "desktop-owner",
      params: {
        conversationId: "thread-123",
        turnStart: { request: turnRequest, context: { inheritThreadSettings: true } },
      },
    });
  });

  it("does not retry after Desktop ownership is confirmed", async () => {
    let startRequests = 0;
    const connectImpl = fakeConnect((request) => {
      if (request.method === "initialize") {
        return {
          type: "response",
          requestId: request.requestId,
          resultType: "success",
          method: "initialize",
          result: { clientId: "weaver-client" },
        };
      }
      if (request.method === "thread-owner-discovery") {
        return {
          type: "response",
          requestId: request.requestId,
          resultType: "success",
          method: request.method,
          handledByClientId: "desktop-owner",
          result: {},
        };
      }
      startRequests += 1;
      return {
        type: "response",
        requestId: request.requestId,
        resultType: "error",
        error: "request-timeout",
      };
    });

    await expect(startDesktopOwnedTurn({
      threadId: "thread-123",
      turnRequest,
      connectImpl,
      timeoutMs: 1_000,
      logger: { log: vi.fn() },
    })).rejects.toThrow("request-timeout");
    expect(startRequests).toBe(1);
  });

  it("retries a discovery timeout before ownership is confirmed", async () => {
    let discoveryRequests = 0;
    const connectImpl = fakeConnect((request) => {
      if (request.method === "initialize") {
        return {
          type: "response",
          requestId: request.requestId,
          resultType: "success",
          method: "initialize",
          result: { clientId: "weaver-client" },
        };
      }
      if (request.method === "thread-owner-discovery") {
        discoveryRequests += 1;
        if (discoveryRequests === 1) return undefined;
        return {
          type: "response",
          requestId: request.requestId,
          resultType: "success",
          method: request.method,
          handledByClientId: "desktop-owner",
          result: {},
        };
      }
      return {
        type: "response",
        requestId: request.requestId,
        resultType: "success",
        method: request.method,
        handledByClientId: "desktop-owner",
        result: { result: { turn: { id: "turn-123", status: "inProgress" } } },
      };
    });

    await expect(startDesktopOwnedTurn({
      threadId: "thread-123",
      turnRequest,
      connectImpl,
      timeoutMs: 1_000,
      ownerDiscoveryTimeoutMs: 25,
      logger: { log: vi.fn() },
    })).resolves.toEqual({ turn: { id: "turn-123", status: "inProgress" } });
    expect(discoveryRequests).toBe(2);
  });
});
