import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const INITIALIZING_CLIENT_ID = "initializing-client";
const LOCAL_HOST_ID = "local";
const OWNER_DISCOVERY_METHOD = "thread-owner-discovery";
const START_TURN_METHOD = "thread-follower-start-turn";
const IPC_VERSIONS = {
  initialize: 0,
  [OWNER_DISCOVERY_METHOD]: 1,
  [START_TURN_METHOD]: 2,
};
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const DEFAULT_HANDOFF_TIMEOUT_MS = 30_000;
const DEFAULT_OWNER_DISCOVERY_TIMEOUT_MS = 6_500;
const OWNER_RETRY_DELAY_MS = 200;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function defaultDesktopIpcPath(environment = process.env) {
  const codexHome = typeof environment.CODEX_HOME === "string" && environment.CODEX_HOME.trim()
    ? environment.CODEX_HOME
    : join(homedir(), ".codex");
  return join(codexHome, "ipc", "ipc.sock");
}

export function encodeDesktopIpcFrame(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  if (payload.length > MAX_FRAME_BYTES) throw new Error("Codex Desktop IPC message is too large.");
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

export class DesktopIpcFrameDecoder {
  constructor(onMessage, onError, maxFrameBytes = MAX_FRAME_BYTES) {
    this.onMessage = onMessage;
    this.onError = onError;
    this.maxFrameBytes = maxFrameBytes;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const frameBytes = this.buffer.readUInt32LE(0);
      if (frameBytes > this.maxFrameBytes) {
        this.buffer = Buffer.alloc(0);
        this.onError(new Error("Codex Desktop IPC emitted an oversized message."));
        return;
      }
      if (this.buffer.length < frameBytes + 4) return;
      const payload = this.buffer.subarray(4, frameBytes + 4);
      this.buffer = this.buffer.subarray(frameBytes + 4);
      try {
        const message = JSON.parse(payload.toString("utf8"));
        if (isObject(message)) this.onMessage(message);
      } catch {
        this.onError(new Error("Codex Desktop IPC emitted invalid JSON."));
        return;
      }
    }
  }
}

class DesktopIpcConnection {
  constructor({ socketPath, connectImpl = connect, requestTimeoutMs = 5_000 }) {
    this.socketPath = socketPath;
    this.connectImpl = connectImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.socket = null;
    this.clientId = INITIALIZING_CLIENT_ID;
    this.pending = new Map();
  }

  async open() {
    if (this.socket?.writable) return;
    await new Promise((resolve, reject) => {
      const socket = this.connectImpl(this.socketPath);
      const fail = (error) => {
        socket.destroy();
        reject(error);
      };
      socket.once("error", fail);
      socket.once("connect", () => {
        socket.off("error", fail);
        this.socket = socket;
        const decoder = new DesktopIpcFrameDecoder(
          (message) => this.handleMessage(message),
          (error) => this.fail(error),
        );
        socket.on("data", (chunk) => decoder.push(chunk));
        socket.on("error", (error) => this.fail(error));
        socket.on("close", () => this.fail(new Error("Codex Desktop IPC connection closed.")));
        resolve();
      });
    });
    const initialized = await this.request("initialize", { clientType: "weaver-backend" });
    if (initialized.resultType !== "success" || !isObject(initialized.result)
        || typeof initialized.result.clientId !== "string") {
      throw new Error("Codex Desktop rejected Weaver's IPC initialization.");
    }
    this.clientId = initialized.result.clientId;
  }

  request(method, params, { targetClientId, timeoutMs = this.requestTimeoutMs } = {}) {
    if (!this.socket?.writable) return Promise.reject(new Error("Codex Desktop IPC is not connected."));
    const requestId = randomUUID();
    const message = {
      type: "request",
      requestId,
      sourceClientId: this.clientId,
      version: IPC_VERSIONS[method] ?? 0,
      method,
      params,
      ...(targetClientId ? { targetClientId } : {}),
      timeoutMs,
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Codex Desktop IPC request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.socket.write(encodeDesktopIpcFrame(message), (error) => {
        if (!error) return;
        const pending = this.pending.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
        pending.reject(error);
      });
    });
  }

  handleMessage(message) {
    if (message.type !== "response" || typeof message.requestId !== "string") return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.requestId);
    pending.resolve(message);
  }

  fail(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    this.socket?.destroy();
    this.socket = null;
  }
}

function desktopIpcError(response, fallback) {
  return new Error(response?.resultType === "error" && typeof response.error === "string"
    ? `Codex Desktop IPC failed: ${response.error}`
    : fallback);
}

export async function startDesktopOwnedTurn({
  threadId,
  turnRequest,
  socketPath = defaultDesktopIpcPath(),
  connectImpl = connect,
  timeoutMs = DEFAULT_HANDOFF_TIMEOUT_MS,
  ownerDiscoveryTimeoutMs = DEFAULT_OWNER_DISCOVERY_TIMEOUT_MS,
  logger = console,
}) {
  if (typeof threadId !== "string" || !/^[A-Za-z0-9_-]+$/.test(threadId)) {
    throw new Error("A valid Codex thread ID is required for Desktop handoff.");
  }
  if (!isObject(turnRequest) || turnRequest.threadId !== threadId) {
    throw new Error("Desktop turn request does not match the Codex thread.");
  }

  const deadline = Date.now() + timeoutMs;
  let lastError = new Error("Codex Desktop has not attached to the task yet.");
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    let ownerConfirmed = false;
    const connection = new DesktopIpcConnection({
      socketPath,
      connectImpl,
      requestTimeoutMs: Math.max(250, Math.min(5_000, remaining)),
    });
    try {
      await connection.open();
      const discovery = await connection.request(OWNER_DISCOVERY_METHOD, {
        hostId: LOCAL_HOST_ID,
        conversationId: threadId,
      }, { timeoutMs: Math.max(250, Math.min(ownerDiscoveryTimeoutMs, deadline - Date.now())) });
      if (discovery.resultType !== "success" || typeof discovery.handledByClientId !== "string") {
        throw desktopIpcError(discovery, "Codex Desktop has not attached to the task yet.");
      }

      ownerConfirmed = true;
      logger.log(`[weaver] Codex Desktop owns thread ${threadId} (${discovery.handledByClientId})`);
      const started = await connection.request(START_TURN_METHOD, {
        conversationId: threadId,
        turnStart: {
          request: turnRequest,
          context: { inheritThreadSettings: true },
        },
      }, {
        targetClientId: discovery.handledByClientId,
        timeoutMs: Math.max(250, deadline - Date.now()),
      });
      if (started.resultType !== "success" || !isObject(started.result) || !isObject(started.result.result)) {
        throw desktopIpcError(started, "Codex Desktop did not accept the turn.");
      }
      return started.result.result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      // Once Desktop ownership was logged, the start request may have been
      // accepted even if its response was lost. Never retry that ambiguity.
      if (ownerConfirmed || !/not attached|no-client-found|ENOENT|ECONNREFUSED|connection closed|request timed out: thread-owner-discovery/i.test(lastError.message)) {
        throw lastError;
      }
    } finally {
      connection.close();
    }
    await delay(Math.min(OWNER_RETRY_DELAY_MS, Math.max(0, deadline - Date.now())));
  }
  throw new Error(`Codex Desktop did not attach to thread ${threadId} before the handoff timed out: ${lastError.message}`);
}
