// @vitest-environment node

import { spawn } from "node:child_process";
import { once } from "node:events";
import { createConnection } from "node:net";
import { resolve } from "node:path";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  codexChildEnvironment,
  createWeaverBackend,
  parseBackendArgs,
} from "../server.mjs";

const extensionId = "abcdefghijklmnopabcdefghijklmnop";
const fixture = resolve(import.meta.dirname, "fixtures/fake-codex.mjs");
const quietLogger = { log() {}, error() {} };

function connect(url, origin = `chrome-extension://${extensionId}`) {
  return new WebSocket(url, { origin });
}

function nextJson(socket) {
  return once(socket, "message").then(([data]) => JSON.parse(String(data)));
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for backend state.");
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
}

describe("backend argument validation", () => {
  it("requires an exact Chrome extension ID and a valid port", () => {
    expect(parseBackendArgs(["--extension-id", extensionId, "--port", "4600"])).toMatchObject({
      extensionId,
      port: 4600,
      host: "127.0.0.1",
    });
    expect(() => parseBackendArgs(["--extension-id", "wrong"])).toThrow("32-character");
    expect(() => parseBackendArgs(["--extension-id", extensionId, "--port", "0"])).toThrow("between 1 and 65535");
  });
});

describe("Codex child environment", () => {
  it("removes only an sfw-injected loopback proxy and temporary CA", () => {
    const caDirectory = "/private/tmp/sfw-test-run";
    const caFile = `${caDirectory}/socketFirewallCa.crt`;
    const result = codexChildEnvironment({
      PATH: "/usr/bin",
      HTTP_PROXY: "http://127.0.0.1:55228",
      HTTPS_PROXY: "http://127.0.0.1:55228",
      NODE_EXTRA_CA_CERTS: caFile,
      SSL_CERT_FILE: caFile,
      SSL_CERT_DIR: caDirectory,
      NO_PROXY: "localhost,127.0.0.1",
    });

    expect(result.bypassedSocketFirewall).toBe(true);
    expect(result.environment).toEqual({
      PATH: "/usr/bin",
      NO_PROXY: "localhost,127.0.0.1",
    });
  });

  it("preserves ordinary proxy and certificate configuration", () => {
    const environment = {
      HTTPS_PROXY: "http://proxy.example:8443",
      SSL_CERT_FILE: "/etc/company-ca.pem",
    };
    const result = codexChildEnvironment(environment);

    expect(result.bypassedSocketFirewall).toBe(false);
    expect(result.environment).toEqual(environment);
  });
});

describe("Weaver backend", () => {
  it("rejects other browser origins", async () => {
    const backend = createWeaverBackend({
      extensionId,
      port: 0,
      codexCommand: process.execPath,
      codexArgs: [fixture],
      logger: quietLogger,
    });
    // The public CLI disallows port zero. Tests use it to request an ephemeral port.
    const address = await backend.start();
    const socket = connect(`ws://127.0.0.1:${address.port}`, "https://x.com");
    const [request, response] = await once(socket, "unexpected-response");
    expect(request).toBeDefined();
    expect(response.statusCode).toBe(403);
    response.destroy();
    await backend.stop();
  });

  it("launches one stdio app-server and preserves initialization across extension reconnects", async () => {
    const backend = createWeaverBackend({
      extensionId,
      port: 0,
      codexCommand: process.execPath,
      codexArgs: [fixture],
      logger: quietLogger,
    });
    const address = await backend.start();
    const url = `ws://127.0.0.1:${address.port}`;

    const first = connect(url);
    await once(first, "open");
    first.send(JSON.stringify({ id: 41, method: "initialize", params: {} }));
    await expect(nextJson(first)).resolves.toEqual({
      id: 41,
      result: { protocolVersion: "test", initializeCount: 1 },
    });
    first.send(JSON.stringify({ method: "initialized", params: {} }));
    first.close();
    await once(first, "close");

    const second = connect(url);
    await once(second, "open");
    second.send(JSON.stringify({ id: 1, method: "initialize", params: {} }));
    await expect(nextJson(second)).resolves.toEqual({
      id: 1,
      result: { protocolVersion: "test", initializeCount: 1 },
    });
    second.send(JSON.stringify({ method: "initialized", params: {} }));
    second.send(JSON.stringify({ id: 2, method: "thread/loaded/list", params: {} }));
    await expect(nextJson(second)).resolves.toEqual({ id: 2, result: { method: "thread/loaded/list" } });

    second.close();
    await once(second, "close");
    await backend.stop();
  });

  it("starts a fixed project-scoped turn through the Codex Desktop owner", async () => {
    const desktopTurnStarter = vi.fn(async () => ({
      turn: { id: "turn-desktop", status: "inProgress" },
    }));
    const backend = createWeaverBackend({
      extensionId,
      port: 0,
      codexCommand: process.execPath,
      codexArgs: [fixture],
      desktopTurnStarter,
      logger: quietLogger,
    });
    const address = await backend.start();
    const socket = connect(`ws://127.0.0.1:${address.port}`);
    await once(socket, "open");
    socket.send(JSON.stringify({ id: 1, method: "initialize", params: {} }));
    await nextJson(socket);
    socket.send(JSON.stringify({ method: "initialized", params: {} }));
    socket.send(JSON.stringify({
      id: 2,
      method: "weaver/desktop-turn/start",
      params: {
        threadId: "thread-test",
        input: [{ type: "text", text: "Build this" }],
        cwd: "/tmp/weaver-project",
        runtimeWorkspaceRoots: ["/tmp/weaver-project"],
        approvalPolicy: "never",
        sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/tmp/weaver-project"] },
      },
    }));

    await expect(nextJson(socket)).resolves.toEqual({
      id: 2,
      result: { turn: { id: "turn-desktop", status: "inProgress" } },
    });
    expect(desktopTurnStarter).toHaveBeenCalledTimes(1);
    expect(desktopTurnStarter).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "thread-test",
      turnRequest: expect.objectContaining({
        cwd: "/tmp/weaver-project",
        approvalPolicy: "never",
      }),
    }));

    socket.close();
    await once(socket, "close");
    await backend.stop();
  });

  it("logs created thread and turn identifiers without logging turn input", async () => {
    const logs = [];
    const logger = {
      log(message) { logs.push(message); },
      error(message) { logs.push(message); },
    };
    const backend = createWeaverBackend({
      extensionId,
      port: 0,
      codexCommand: process.execPath,
      codexArgs: [fixture],
      desktopTurnStarter: async () => ({ turn: { id: "turn-test", status: "inProgress" } }),
      logger,
    });
    const address = await backend.start();
    const socket = connect(`ws://127.0.0.1:${address.port}`);
    await once(socket, "open");
    socket.send(JSON.stringify({ id: 1, method: "initialize", params: {} }));
    await nextJson(socket);
    socket.send(JSON.stringify({ method: "initialized", params: {} }));
    socket.send(JSON.stringify({
      id: 2,
      method: "thread/start",
      params: { cwd: "/tmp/weaver-project" },
    }));
    await nextJson(socket);
    socket.send(JSON.stringify({
      id: 3,
      method: "weaver/desktop-turn/start",
      params: {
        threadId: "thread-test",
        input: [{ type: "text", text: "private post contents" }],
        cwd: "/tmp/weaver-project",
        runtimeWorkspaceRoots: ["/tmp/weaver-project"],
        approvalPolicy: "never",
        sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/tmp/weaver-project"] },
      },
    }));
    await nextJson(socket);
    expect(logs).toContain("[weaver] Created Codex thread thread-test (project: /tmp/weaver-project)");
    expect(logs).toContain("[weaver] Open task: codex://threads/thread-test");
    expect(logs).toContain("[weaver] Started Codex Desktop turn turn-test in thread thread-test");
    expect(logs.join("\n")).not.toContain("private post contents");

    socket.close();
    await once(socket, "close");
    await backend.stop();
  });

  it("rejects backend-owned turn start and resume requests", async () => {
    const backend = createWeaverBackend({
      extensionId,
      port: 0,
      codexCommand: process.execPath,
      codexArgs: [fixture],
      logger: quietLogger,
    });
    const address = await backend.start();
    const socket = connect(`ws://127.0.0.1:${address.port}`);
    await once(socket, "open");
    socket.send(JSON.stringify({ id: 1, method: "initialize", params: {} }));
    await nextJson(socket);
    socket.send(JSON.stringify({ method: "initialized", params: {} }));

    socket.send(JSON.stringify({ id: 2, method: "turn/start", params: { threadId: "thread-test" } }));
    await expect(nextJson(socket)).resolves.toMatchObject({
      id: 2,
      error: { code: -32011, message: expect.stringContaining("Desktop ownership") },
    });
    socket.send(JSON.stringify({ id: 3, method: "thread/resume", params: { threadId: "thread-test" } }));
    await expect(nextJson(socket)).resolves.toMatchObject({
      id: 3,
      error: { code: -32011, message: expect.stringContaining("Desktop ownership") },
    });

    socket.close();
    await once(socket, "close");
    await backend.stop();
  });

  it("expires unanswered requests instead of retaining them indefinitely", async () => {
    let spawnCount = 0;
    const spawnImpl = (command, _args, options) => {
      spawnCount += 1;
      const args = spawnCount === 1 ? [fixture, "--ignore-method=thread/loaded/list"] : [fixture];
      return spawn(command, args, options);
    };
    const backend = createWeaverBackend({
      extensionId,
      port: 0,
      codexCommand: process.execPath,
      codexArgs: [fixture],
      spawnImpl,
      requestTimeoutMs: 100,
      restartDelayMs: 5,
      maxRestartDelayMs: 10,
      logger: quietLogger,
    });
    const address = await backend.start();
    const url = `ws://127.0.0.1:${address.port}`;
    const socket = connect(url);
    await once(socket, "open");
    socket.send(JSON.stringify({ id: 1, method: "initialize", params: {} }));
    await nextJson(socket);
    socket.send(JSON.stringify({ method: "initialized", params: {} }));
    socket.send(JSON.stringify({ id: 2, method: "thread/loaded/list", params: {} }));

    await expect(nextJson(socket)).resolves.toEqual({
      id: 2,
      error: { code: -32002, message: "Codex app-server request timed out: thread/loaded/list" },
    });
    await once(socket, "close");
    await waitFor(() => spawnCount >= 2);

    const recovered = connect(url);
    await once(recovered, "open");
    recovered.send(JSON.stringify({ id: 3, method: "initialize", params: {} }));
    await expect(nextJson(recovered)).resolves.toMatchObject({ id: 3, result: { protocolVersion: "test" } });

    recovered.close();
    await once(recovered, "close");
    await backend.stop();
  });

  it("restarts a stuck initialization so a later connection can recover", async () => {
    let spawnCount = 0;
    const spawnImpl = (command, _args, options) => {
      spawnCount += 1;
      const args = spawnCount === 1 ? [fixture, "--ignore-method=initialize"] : [fixture];
      return spawn(command, args, options);
    };
    const backend = createWeaverBackend({
      extensionId,
      port: 0,
      codexCommand: process.execPath,
      codexArgs: [fixture],
      spawnImpl,
      requestTimeoutMs: 100,
      restartDelayMs: 5,
      maxRestartDelayMs: 10,
      logger: quietLogger,
    });
    const address = await backend.start();
    const url = `ws://127.0.0.1:${address.port}`;
    const first = connect(url);
    await once(first, "open");
    first.send(JSON.stringify({ id: 1, method: "initialize", params: {} }));
    await expect(nextJson(first)).resolves.toEqual({
      id: 1,
      error: { code: -32002, message: "Codex app-server initialization timed out." },
    });
    await once(first, "close");
    await waitFor(() => spawnCount >= 2);

    const second = connect(url);
    await once(second, "open");
    second.send(JSON.stringify({ id: 2, method: "initialize", params: {} }));
    await expect(nextJson(second)).resolves.toMatchObject({ id: 2, result: { protocolVersion: "test" } });

    second.close();
    await once(second, "close");
    await backend.stop();
  });

  it("keeps retrying when a supervised restart fails to spawn", async () => {
    let spawnCount = 0;
    const spawnImpl = (command, args, options) => {
      spawnCount += 1;
      if (spawnCount === 2) return spawn("/weaver-missing-codex", [], options);
      return spawn(command, args, options);
    };
    const backend = createWeaverBackend({
      extensionId,
      port: 0,
      codexCommand: process.execPath,
      codexArgs: [fixture],
      spawnImpl,
      restartDelayMs: 5,
      maxRestartDelayMs: 10,
      logger: quietLogger,
    });
    const address = await backend.start();
    const url = `ws://127.0.0.1:${address.port}`;
    const first = connect(url);
    await once(first, "open");
    first.send(JSON.stringify({ id: 1, method: "initialize", params: {} }));
    await nextJson(first);
    first.send(JSON.stringify({ method: "initialized", params: {} }));
    first.send(JSON.stringify({ id: 2, method: "test/exit", params: {} }));
    await once(first, "close");
    await waitFor(() => spawnCount >= 3);

    const second = connect(url);
    await once(second, "open");
    second.send(JSON.stringify({ id: 3, method: "initialize", params: {} }));
    await expect(nextJson(second)).resolves.toMatchObject({ id: 3, result: { protocolVersion: "test" } });

    second.close();
    await once(second, "close");
    await backend.stop();
  });

  it("stops even when an extension client does not answer the close handshake", async () => {
    const backend = createWeaverBackend({
      extensionId,
      port: 0,
      codexCommand: process.execPath,
      codexArgs: [fixture],
      logger: quietLogger,
    });
    const address = await backend.start();
    const socket = connect(`ws://127.0.0.1:${address.port}`);
    await once(socket, "open");
    socket._socket.pause();

    const stopPromise = backend.stop();
    let timeout;
    const boundedStop = Promise.race([
      stopPromise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Backend shutdown timed out.")), 1_000);
      }),
    ]);
    try {
      await expect(boundedStop).resolves.toBeUndefined();
    } finally {
      clearTimeout(timeout);
      socket.terminate();
      await stopPromise;
    }
  });

  it("stops even when an HTTP client never finishes its request headers", async () => {
    const backend = createWeaverBackend({
      extensionId,
      port: 0,
      codexCommand: process.execPath,
      codexArgs: [fixture],
      logger: quietLogger,
    });
    const address = await backend.start();
    const socket = createConnection({ host: "127.0.0.1", port: address.port });
    socket.on("error", () => {
      // Shutdown intentionally resets this incomplete HTTP connection.
    });
    await once(socket, "connect");
    socket.write("GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\n");

    const stopPromise = backend.stop();
    let timeout;
    const boundedStop = Promise.race([
      stopPromise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Backend shutdown timed out.")), 1_000);
      }),
    ]);
    try {
      await expect(boundedStop).resolves.toBeUndefined();
    } finally {
      clearTimeout(timeout);
      socket.destroy();
      await stopPromise;
    }
  });
});
