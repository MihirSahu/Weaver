import { validateLoopbackEndpoint } from "../shared/validation";

export interface InitializeResult {
  userAgent?: string;
  protocolVersion?: string;
  platformFamily?: string;
  platformOs?: string;
}

export interface RpcNotification {
  method: string;
  params?: unknown;
}

interface RpcResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class RpcError extends Error {
  constructor(public readonly code: number, message: string, public readonly data?: unknown) {
    super(message);
    this.name = "RpcError";
  }
}

export class CodexClient {
  private socket: WebSocket | null = null;
  private connectPromise: Promise<InitializeResult> | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private listeners = new Set<(notification: RpcNotification) => void>();
  private disconnectListeners = new Set<() => void>();
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private initialization: InitializeResult | null = null;
  private closingExplicitly = false;

  readonly endpoint: string;

  constructor(endpoint: string, private readonly requestTimeoutMs = 20_000) {
    this.endpoint = validateLoopbackEndpoint(endpoint);
  }

  get isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN && this.initialization !== null;
  }

  onNotification(listener: (notification: RpcNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  async connect(): Promise<InitializeResult> {
    if (this.isConnected && this.initialization) return this.initialization;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.openAndInitialize().finally(() => { this.connectPromise = null; });
    return this.connectPromise;
  }

  private async openAndInitialize(): Promise<InitializeResult> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.openSocket();
        const result = await this.rawRequest<InitializeResult>("initialize", {
          clientInfo: { name: "weaver_chrome_extension", title: "Weaver", version: "0.1.0" },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
            optOutNotificationMethods: ["item/agentMessage/delta"],
          },
        });
        this.send({ method: "initialized", params: {} });
        this.initialization = result;
        this.startKeepalive();
        return result;
      } catch (error) {
        lastError = error;
        this.close();
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Codex app-server is offline.");
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.endpoint);
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error("Timed out connecting to Codex app-server."));
      }, 4_000);
      socket.addEventListener("open", () => {
        clearTimeout(timeout);
        this.socket = socket;
        resolve();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("Codex app-server is offline."));
      }, { once: true });
      socket.addEventListener("message", (event) => this.handleMessage(event.data));
      socket.addEventListener("close", () => this.handleClose(socket));
    });
  }

  async request<T>(method: string, params: unknown = {}): Promise<T> {
    await this.connect();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.rawRequest<T>(method, params);
      } catch (error) {
        if (!(error instanceof RpcError) || error.code !== -32001 || attempt === 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt + Math.floor(Math.random() * 100)));
      }
    }
    throw new Error("Codex app-server did not accept the request.");
  }

  private rawRequest<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timeout });
      try {
        this.send({ method, id, params });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private send(message: unknown): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error("Codex app-server connection is not open.");
    this.socket.send(JSON.stringify(message));
  }

  private handleMessage(data: unknown): void {
    let message: RpcResponse | (RpcNotification & { id?: string | number });
    try {
      message = JSON.parse(String(data)) as typeof message;
    } catch {
      return;
    }
    if (typeof message.id === "number" && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new RpcError(message.error.code, message.error.message, message.error.data));
      else pending.resolve(message.result);
      return;
    }
    if ((typeof message.id === "number" || typeof message.id === "string") && "method" in message) {
      this.send({ id: message.id, error: { code: -32601, message: "Weaver does not support server-initiated requests." } });
      return;
    }
    if ("method" in message) this.listeners.forEach((listener) => listener(message));
  }

  private startKeepalive(): void {
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = setInterval(() => {
      if (this.isConnected) void this.rawRequest("thread/loaded/list", {}).catch(() => undefined);
    }, 20_000);
  }

  private handleClose(socket: WebSocket): void {
    if (this.socket !== socket) return;
    const notify = !this.closingExplicitly && this.initialization !== null;
    this.initialization = null;
    this.socket = null;
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Codex app-server disconnected."));
    }
    this.pending.clear();
    if (notify) this.disconnectListeners.forEach((listener) => listener());
  }

  close(): void {
    const socket = this.socket;
    if (!socket) return;
    this.closingExplicitly = true;
    try {
      socket.close();
      this.handleClose(socket);
    } finally {
      this.closingExplicitly = false;
    }
  }
}
