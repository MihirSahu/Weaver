#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { startDesktopOwnedTurn } from "./desktop-ipc.mjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4500;
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 18_000;
const DEFAULT_RESTART_DELAY_MS = 500;
const MAX_RESTART_DELAY_MS = 5_000;
const FORCE_KILL_DELAY_MS = 2_000;
const CHROME_EXTENSION_ID = /^[a-p]{32}$/;
const SOCKET_FIREWALL_CA_NAME = "socketFirewallCa.crt";
const DESKTOP_TURN_START_METHOD = "weaver/desktop-turn/start";

const PROXY_ENV_KEYS = [
  "ALL_PROXY",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "all_proxy",
  "https_proxy",
  "http_proxy",
];

const CA_ENV_KEYS = [
  "CARGO_HTTP_CAINFO",
  "CURL_CA_BUNDLE",
  "GIT_PROXY_SSL_CAINFO",
  "GIT_SSL_CAINFO",
  "NODE_EXTRA_CA_CERTS",
  "PIP_CERT",
  "REQUESTS_CA_BUNDLE",
  "SSL_CERT_FILE",
];

function usage() {
  return `Usage: sfw pnpm backend --extension-id <chrome-extension-id> [--port <port>]

Starts a loopback-only Weaver backend and launches Codex app-server over stdio.

Options:
  --extension-id <id>  Required 32-character Chrome extension ID.
  --port <port>        Loopback WebSocket port (default: ${DEFAULT_PORT}).
  --help               Show this help message.`;
}

export function parseBackendArgs(argv) {
  const options = { host: DEFAULT_HOST, port: DEFAULT_PORT, extensionId: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { ...options, help: true };
    if (argument === "--extension-id") {
      options.extensionId = argv[++index] ?? "";
      continue;
    }
    if (argument === "--port") {
      options.port = Number(argv[++index]);
      continue;
    }
    throw new Error(`Unknown backend option: ${argument ?? ""}`);
  }
  if (!CHROME_EXTENSION_ID.test(options.extensionId)) {
    throw new Error("--extension-id must be the 32-character ID shown for Weaver in chrome://extensions.");
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
    throw new Error("--port must be an integer between 1 and 65535.");
  }
  return options;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isLoopbackProxy(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

function isSocketFirewallCa(value) {
  if (typeof value !== "string") return false;
  const normalized = value.replaceAll("\\", "/");
  return normalized.endsWith(`/${SOCKET_FIREWALL_CA_NAME}`)
    && normalized.split("/").some((segment) => segment.startsWith("sfw-"));
}

export function codexChildEnvironment(environment = process.env) {
  const childEnvironment = { ...environment };
  const socketFirewallCa = CA_ENV_KEYS
    .map((key) => environment[key])
    .find((value) => isSocketFirewallCa(value));
  const socketFirewallProxy = PROXY_ENV_KEYS
    .map((key) => environment[key])
    .find((value) => isLoopbackProxy(value));

  if (!socketFirewallCa || !socketFirewallProxy) {
    return { environment: childEnvironment, bypassedSocketFirewall: false };
  }

  for (const key of PROXY_ENV_KEYS) {
    if (isLoopbackProxy(childEnvironment[key])) delete childEnvironment[key];
  }
  for (const key of CA_ENV_KEYS) {
    if (childEnvironment[key] === socketFirewallCa || isSocketFirewallCa(childEnvironment[key])) {
      delete childEnvironment[key];
    }
  }
  if (typeof childEnvironment.SSL_CERT_DIR === "string"
      && childEnvironment.SSL_CERT_DIR.replaceAll("\\", "/").split("/").some((segment) => segment.startsWith("sfw-"))) {
    delete childEnvironment.SSL_CERT_DIR;
  }

  return { environment: childEnvironment, bypassedSocketFirewall: true };
}

function hasId(message) {
  return typeof message.id === "number" || typeof message.id === "string";
}

function isResponse(message) {
  return hasId(message) && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"));
}

function lifecycleContext(message) {
  if (!["thread/start", "thread/resume", "turn/start"].includes(message.method) || !isObject(message.params)) return undefined;
  return {
    cwd: typeof message.params.cwd === "string" ? message.params.cwd : undefined,
    threadId: typeof message.params.threadId === "string" ? message.params.threadId : undefined,
  };
}

function desktopTurnRequest(params) {
  if (!isObject(params) || typeof params.threadId !== "string" || !/^[A-Za-z0-9_-]+$/.test(params.threadId)) {
    throw new Error("Desktop turn start requires a valid Codex thread ID.");
  }
  if (!Array.isArray(params.input) || params.input.length === 0) {
    throw new Error("Desktop turn start requires a non-empty input array.");
  }
  if (typeof params.cwd !== "string" || !params.cwd.trim()) {
    throw new Error("Desktop turn start requires a project working directory.");
  }
  if (!Array.isArray(params.runtimeWorkspaceRoots)
      || params.runtimeWorkspaceRoots.length !== 1
      || params.runtimeWorkspaceRoots[0] !== params.cwd) {
    throw new Error("Desktop turn start must be restricted to its project directory.");
  }
  if (params.approvalPolicy !== "never") {
    throw new Error("Desktop turn start requires Weaver's non-interactive approval policy.");
  }
  if (!isObject(params.sandboxPolicy)
      || params.sandboxPolicy.type !== "workspaceWrite"
      || !Array.isArray(params.sandboxPolicy.writableRoots)
      || params.sandboxPolicy.writableRoots.length !== 1
      || params.sandboxPolicy.writableRoots[0] !== params.cwd) {
    throw new Error("Desktop turn start must use a project-scoped workspace-write sandbox.");
  }
  return {
    threadId: params.threadId,
    input: params.input,
    cwd: params.cwd,
    runtimeWorkspaceRoots: [params.cwd],
    approvalPolicy: "never",
    sandboxPolicy: { type: "workspaceWrite", writableRoots: [params.cwd] },
  };
}

class JsonLineDecoder {
  constructor(onLine, onError, maxBytes = MAX_MESSAGE_BYTES) {
    this.onLine = onLine;
    this.onError = onError;
    this.maxBytes = maxBytes;
    this.buffer = "";
  }

  push(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > this.maxBytes) {
      this.buffer = "";
      this.onError(new Error("Codex app-server emitted an oversized JSONL message."));
      return;
    }
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim()) this.onLine(line);
    }
  }
}

class CodexStdioBridge {
  constructor({
    codexCommand = "codex",
    codexArgs = ["app-server", "--stdio"],
    spawnImpl = spawn,
    logger = console,
    maxMessageBytes = MAX_MESSAGE_BYTES,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    restartDelayMs = DEFAULT_RESTART_DELAY_MS,
    maxRestartDelayMs = MAX_RESTART_DELAY_MS,
    environment = process.env,
    desktopTurnStarter = startDesktopOwnedTurn,
  } = {}) {
    this.codexCommand = codexCommand;
    this.codexArgs = codexArgs;
    this.spawnImpl = spawnImpl;
    this.logger = logger;
    this.maxMessageBytes = maxMessageBytes;
    this.requestTimeoutMs = requestTimeoutMs;
    this.restartDelayMs = restartDelayMs;
    this.maxRestartDelayMs = maxRestartDelayMs;
    this.environment = environment;
    this.desktopTurnStarter = desktopTurnStarter;
    this.child = null;
    this.activeSocket = null;
    this.readySockets = new WeakSet();
    this.pending = new Map();
    this.initializeWaiters = [];
    this.nextUpstreamId = 1;
    this.initializeResult = undefined;
    this.initializedNotificationSent = false;
    this.startPromise = null;
    this.stopping = false;
    this.restartTimer = null;
    this.restartAttempts = 0;
    this.forceKillTimer = null;
  }

  get running() {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
  }

  async start() {
    if (this.stopping) throw new Error("Weaver backend is stopping.");
    if (this.running) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise((resolve, reject) => {
      const childEnvironment = codexChildEnvironment(this.environment);
      if (childEnvironment.bypassedSocketFirewall) {
        this.logger.log("[weaver] Codex app-server will connect directly; sfw remains active for pnpm only.");
      }
      const child = this.spawnImpl(this.codexCommand, this.codexArgs, {
        env: childEnvironment.environment,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
      });
      let settled = false;
      const failStart = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      child.once("error", failStart);
      child.once("spawn", () => {
        if (settled) return;
        if (this.stopping) {
          settled = true;
          child.kill("SIGKILL");
          reject(new Error("Weaver backend stopped while Codex app-server was starting."));
          return;
        }
        settled = true;
        this.child = child;
        this.attachChild(child);
        resolve();
      });
    }).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  attachChild(child) {
    const decoder = new JsonLineDecoder(
      (line) => this.handleCodexLine(line),
      (error) => this.handleProtocolFailure(error),
      this.maxMessageBytes,
    );
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => decoder.push(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line) this.logger.error(`[codex] ${line}`);
      }
    });
    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      if (this.forceKillTimer) clearTimeout(this.forceKillTimer);
      this.forceKillTimer = null;
      this.child = null;
      this.resetSession();
      if (this.activeSocket?.readyState === WebSocket.OPEN) {
        this.activeSocket.close(1011, "Codex app-server exited");
      }
      if (!this.stopping) {
        this.logger.error(`Codex app-server exited (${signal ?? code ?? "unknown"}); restarting.`);
        this.scheduleRestart();
      }
    });
  }

  scheduleRestart() {
    if (this.stopping || this.restartTimer || this.running) return;
    const delay = Math.min(this.restartDelayMs * 2 ** this.restartAttempts, this.maxRestartDelayMs);
    this.restartAttempts += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.start().then(
        () => { this.restartAttempts = 0; },
        (error) => {
          this.logger.error(`Could not restart Codex app-server: ${error.message}`);
          this.scheduleRestart();
        },
      );
    }, delay);
    this.restartTimer.unref?.();
  }

  resetSession() {
    for (const request of this.pending.values()) clearTimeout(request.timeout);
    this.initializeResult = undefined;
    this.initializedNotificationSent = false;
    this.pending.clear();
    this.initializeWaiters = [];
    this.readySockets = new WeakSet();
  }

  attachSocket(socket) {
    const previous = this.activeSocket;
    if (previous && previous !== socket && previous.readyState === WebSocket.OPEN) {
      previous.close(1012, "A newer Weaver connection replaced this one");
    }
    this.dropSocket(previous);
    this.activeSocket = socket;
  }

  dropSocket(socket) {
    if (!socket) return;
    for (const [upstreamId, request] of this.pending) {
      if (request.socket === socket && request.method !== "initialize") {
        clearTimeout(request.timeout);
        this.pending.delete(upstreamId);
      }
    }
    this.initializeWaiters = this.initializeWaiters.filter((waiter) => waiter.socket !== socket);
    if (this.activeSocket === socket) this.activeSocket = null;
  }

  handleClientMessage(socket, raw, isBinary) {
    if (isBinary) throw new Error("Binary WebSocket messages are not supported.");
    const text = String(raw);
    if (Buffer.byteLength(text) > this.maxMessageBytes) throw new Error("WebSocket message is too large.");
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      throw new Error("WebSocket message must contain valid JSON.");
    }
    if (!isObject(message)) throw new Error("WebSocket message must contain a JSON object.");

    if (["thread/resume", "turn/start"].includes(message.method) && hasId(message)) {
      this.sendSocket(socket, {
        id: message.id,
        error: {
          code: -32011,
          message: "Weaver requires Codex Desktop ownership; backend-owned resume and turn start are disabled.",
        },
      });
      return;
    }

    if (message.method === DESKTOP_TURN_START_METHOD && hasId(message)) {
      if (!this.readySockets.has(socket)) {
        this.sendSocket(socket, {
          id: message.id,
          error: { code: -32000, message: "Initialize Weaver before starting a Desktop turn." },
        });
        return;
      }
      const turnRequest = desktopTurnRequest(message.params);
      void this.handleDesktopTurnStart(socket, message.id, turnRequest);
      return;
    }

    if (message.method === "initialize" && hasId(message)) {
      if (this.initializeResult !== undefined) {
        this.readySockets.add(socket);
        this.sendSocket(socket, { id: message.id, result: this.initializeResult });
        return;
      }
      if ([...this.pending.values()].some((request) => request.method === "initialize")) {
        this.initializeWaiters.push({ socket, clientId: message.id });
        return;
      }
    }
    if (message.method === "initialized" && !hasId(message)) {
      if (this.initializedNotificationSent) return;
      this.initializedNotificationSent = true;
      this.writeCodex(message);
      return;
    }
    if (hasId(message) && typeof message.method === "string") {
      const upstreamId = this.nextUpstreamId++;
      const timeout = setTimeout(() => this.handleRequestTimeout(upstreamId), this.requestTimeoutMs);
      timeout.unref?.();
      this.pending.set(upstreamId, {
        socket,
        clientId: message.id,
        method: message.method,
        lifecycle: lifecycleContext(message),
        timeout,
      });
      try {
        this.writeCodex({ ...message, id: upstreamId });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(upstreamId);
        throw error;
      }
      return;
    }
    if (isResponse(message)) {
      throw new Error("Unexpected client response without a pending server request.");
    }
    if (typeof message.method === "string") {
      this.writeCodex(message);
      return;
    }
    throw new Error("JSON-RPC message must include a method or response.");
  }

  async handleDesktopTurnStart(socket, clientId, turnRequest) {
    try {
      const result = await this.desktopTurnStarter({
        threadId: turnRequest.threadId,
        turnRequest,
        logger: this.logger,
      });
      const turn = isObject(result) && isObject(result.turn) ? result.turn : undefined;
      if (!turn || typeof turn.id !== "string") {
        throw new Error("Codex Desktop accepted the handoff without returning a turn ID.");
      }
      this.logger.log(`[weaver] Started Codex Desktop turn ${turn.id} in thread ${turnRequest.threadId}`);
      this.sendSocket(socket, { id: clientId, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[weaver] Codex Desktop handoff failed for thread ${turnRequest.threadId}: ${message}`);
      this.sendSocket(socket, { id: clientId, error: { code: -32010, message } });
    }
  }

  writeCodex(message) {
    if (!this.running || !this.child?.stdin.writable) throw new Error("Codex app-server is not running.");
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line) > this.maxMessageBytes) throw new Error("JSON-RPC message is too large.");
    this.child.stdin.write(line);
  }

  handleCodexLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.handleProtocolFailure(new Error("Codex app-server emitted invalid JSONL."));
      return;
    }
    if (!isObject(message)) return;
    if (isResponse(message)) {
      const request = this.pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timeout);
      this.pending.delete(message.id);
      if (request.method === "initialize" && Object.hasOwn(message, "result")) {
        this.initializeResult = message.result;
        this.readySockets.add(request.socket);
      }
      this.logLifecycleResponse(request, message);
      this.sendSocket(request.socket, { ...message, id: request.clientId });
      if (request.method === "initialize") {
        for (const waiter of this.initializeWaiters) {
          if (Object.hasOwn(message, "result")) this.readySockets.add(waiter.socket);
          this.sendSocket(waiter.socket, { ...message, id: waiter.clientId });
        }
        this.initializeWaiters = [];
      }
      return;
    }
    if (hasId(message) && typeof message.method === "string") {
      this.writeCodex({
        id: message.id,
        error: { code: -32601, message: "Weaver does not support server-initiated requests." },
      });
      return;
    }
    if (typeof message.method === "string") {
      this.logLifecycleNotification(message);
      const socket = this.activeSocket;
      if (socket && this.readySockets.has(socket)) this.sendSocket(socket, message);
    }
  }

  logLifecycleResponse(request, message) {
    if (!request.lifecycle) return;
    if (Object.hasOwn(message, "error")) {
      const detail = isObject(message.error) && typeof message.error.message === "string"
        ? `: ${message.error.message}`
        : "";
      this.logger.error(`[weaver] Codex ${request.method} failed${detail}`);
      return;
    }
    if (!isObject(message.result)) return;
    if (request.method === "thread/start") {
      const thread = isObject(message.result.thread) ? message.result.thread : undefined;
      if (!thread || typeof thread.id !== "string") return;
      const project = request.lifecycle.cwd ? ` (project: ${request.lifecycle.cwd})` : "";
      this.logger.log(`[weaver] Created Codex thread ${thread.id}${project}`);
      this.logger.log(`[weaver] Open task: codex://threads/${encodeURIComponent(thread.id)}`);
      return;
    }
    if (request.method === "thread/resume") {
      if (!request.lifecycle.threadId) return;
      const project = request.lifecycle.cwd ? ` (project: ${request.lifecycle.cwd})` : "";
      this.logger.log(`[weaver] Resumed Codex thread ${request.lifecycle.threadId}${project}`);
      this.logger.log(`[weaver] Open task: codex://threads/${encodeURIComponent(request.lifecycle.threadId)}`);
      return;
    }
    if (request.method === "turn/start") {
      const turn = isObject(message.result.turn) ? message.result.turn : undefined;
      if (!turn || typeof turn.id !== "string") return;
      const thread = request.lifecycle.threadId ? ` in thread ${request.lifecycle.threadId}` : "";
      this.logger.log(`[weaver] Started Codex turn ${turn.id}${thread}`);
    }
  }

  logLifecycleNotification(message) {
    if (message.method !== "turn/completed" || !isObject(message.params)) return;
    const turn = isObject(message.params.turn) ? message.params.turn : undefined;
    if (!turn || typeof turn.id !== "string") return;
    const status = typeof turn.status === "string" ? ` with status ${turn.status}` : "";
    const thread = typeof message.params.threadId === "string" ? ` in thread ${message.params.threadId}` : "";
    this.logger.log(`[weaver] Codex turn ${turn.id} completed${status}${thread}`);
  }

  sendSocket(socket, message) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  handleRequestTimeout(upstreamId) {
    const request = this.pending.get(upstreamId);
    if (!request) return;
    this.pending.delete(upstreamId);
    const message = request.method === "initialize"
      ? "Codex app-server initialization timed out."
      : `Codex app-server request timed out: ${request.method}`;
    const response = { error: { code: -32002, message } };
    this.sendSocket(request.socket, { id: request.clientId, ...response });
    if (request.method === "initialize") {
      for (const waiter of this.initializeWaiters) {
        this.sendSocket(waiter.socket, { id: waiter.clientId, ...response });
      }
      this.initializeWaiters = [];
    }
    this.restartUnresponsiveChild(message);
  }

  restartUnresponsiveChild(message) {
    this.logger.error(message);
    const child = this.child;
    if (!child || child.exitCode !== null) {
      this.resetSession();
      this.scheduleRestart();
      return;
    }
    child.kill("SIGTERM");
    if (!this.forceKillTimer) {
      this.forceKillTimer = setTimeout(() => {
        if (this.child === child && child.exitCode === null) child.kill("SIGKILL");
      }, FORCE_KILL_DELAY_MS);
      this.forceKillTimer.unref?.();
    }
  }

  handleProtocolFailure(error) {
    if (this.activeSocket?.readyState === WebSocket.OPEN) this.activeSocket.close(1011, error.message);
    this.restartUnresponsiveChild(error.message);
  }

  async stop() {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.forceKillTimer) clearTimeout(this.forceKillTimer);
    this.forceKillTimer = null;
    if (this.startPromise) await this.startPromise.catch(() => undefined);
    const child = this.child;
    this.child = null;
    this.resetSession();
    if (!child || child.exitCode !== null) return;
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }
}

export function createWeaverBackend({
  extensionId,
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  codexCommand = "codex",
  codexArgs = ["app-server", "--stdio"],
  spawnImpl = spawn,
  logger = console,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  restartDelayMs = DEFAULT_RESTART_DELAY_MS,
  maxRestartDelayMs = MAX_RESTART_DELAY_MS,
  environment = process.env,
  desktopTurnStarter = startDesktopOwnedTurn,
} = {}) {
  if (!CHROME_EXTENSION_ID.test(extensionId ?? "")) throw new Error("A valid Chrome extension ID is required.");
  if (host !== DEFAULT_HOST) throw new Error("Weaver backend may only bind to 127.0.0.1.");
  const expectedOrigin = `chrome-extension://${extensionId}`;
  const bridge = new CodexStdioBridge({
    codexCommand,
    codexArgs,
    spawnImpl,
    logger,
    requestTimeoutMs,
    restartDelayMs,
    maxRestartDelayMs,
    environment,
    desktopTurnStarter,
  });
  const sockets = new Set();
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  const httpServer = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      response.writeHead(bridge.running ? 200 : 503, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: bridge.running, codexAppServer: bridge.running ? "running" : "offline" }));
      return;
    }
    response.writeHead(404).end();
  });

  httpServer.on("upgrade", (request, socket, head) => {
    const origin = request.headers.origin;
    if (request.url !== "/" || origin !== expectedOrigin) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit("connection", webSocket, request);
    });
  });

  webSocketServer.on("connection", (socket) => {
    sockets.add(socket);
    bridge.attachSocket(socket);
    socket.on("message", (data, isBinary) => {
      try {
        bridge.handleClientMessage(socket, data, isBinary);
      } catch (error) {
        logger.error(`Rejected Weaver message: ${error.message}`);
        socket.close(1008, error.message.slice(0, 120));
      }
    });
    socket.once("close", () => {
      sockets.delete(socket);
      bridge.dropSocket(socket);
    });
  });

  return {
    async start() {
      await bridge.start();
      try {
        await new Promise((resolve, reject) => {
          const onError = (error) => reject(error);
          httpServer.once("error", onError);
          httpServer.listen(port, host, () => {
            httpServer.off("error", onError);
            resolve();
          });
        });
      } catch (error) {
        await bridge.stop();
        throw error;
      }
      const address = httpServer.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      logger.log(`Weaver backend listening on ws://${host}:${actualPort}`);
      logger.log(`Allowed extension origin: ${expectedOrigin}`);
      return { host, port: actualPort };
    },
    async stop() {
      // A graceful close can wait forever for a peer that never answers the
      // closing handshake. The process is shutting down, so tear down each
      // relay connection before waiting for the server's close event.
      for (const socket of sockets) socket.terminate();
      await new Promise((resolve) => webSocketServer.close(() => resolve()));
      if (httpServer.listening) {
        const closed = new Promise((resolve) => httpServer.close(() => resolve()));
        // `close()` stops new requests but can still wait on a connection that
        // never completed its headers. Destroy those remaining loopback peers.
        httpServer.closeAllConnections();
        await closed;
      }
      await bridge.stop();
    },
  };
}

async function main() {
  let options;
  try {
    options = parseBackendArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(`\n${usage()}`);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    console.log(usage());
    return;
  }
  const backend = createWeaverBackend(options);
  await backend.start();
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await backend.stop();
  };
  process.once("SIGINT", () => { void stop().then(() => process.exit(0)); });
  process.once("SIGTERM", () => { void stop().then(() => process.exit(0)); });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
