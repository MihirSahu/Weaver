import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexClient } from "../src/background/codex-client";

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readonly sent: Array<Record<string, unknown>> = [];
  readyState = FakeWebSocket.CONNECTING;

  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }

  send(raw: string): void {
    const message = JSON.parse(raw) as { id?: number; method: string };
    this.sent.push(message as unknown as Record<string, unknown>);
    if (message.method === "initialize") this.respond(message.id!, { userAgent: "codex-cli/0.145.0", platformOs: "windows" });
    if (message.method === "thread/list") this.respond(message.id!, { data: [], nextCursor: null });
    if (message.method === "broken/method") this.fail(message.id!, 99, "Expected failure");
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }

  private respond(id: number, result: unknown): void {
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id, result }) })));
  }

  private fail(id: number, code: number, message: string): void {
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id, error: { code, message } }) })));
  }
}

describe("Codex JSON-RPC client", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    Object.assign(globalThis, { WebSocket: FakeWebSocket });
  });

  afterEach(() => { FakeWebSocket.instances.forEach((socket) => socket.close()); });

  it("performs the handshake and correlates request responses", async () => {
    const client = new CodexClient("ws://127.0.0.1:4500", 1_000);
    const initialized = await client.connect();
    const result = await client.request<{ data: unknown[] }>("thread/list", {});
    const methods = FakeWebSocket.instances[0]!.sent.map((message) => message.method);
    expect(initialized.platformOs).toBe("windows");
    expect(result.data).toEqual([]);
    expect(methods.slice(0, 3)).toEqual(["initialize", "initialized", "thread/list"]);
    expect(FakeWebSocket.instances[0]!.sent[0]).toMatchObject({
      method: "initialize",
      params: { capabilities: { experimentalApi: true, requestAttestation: false } },
    });
    client.close();
  });

  it("surfaces correlated JSON-RPC errors", async () => {
    const client = new CodexClient("ws://127.0.0.1:4500", 1_000);
    await expect(client.request("broken/method", {})).rejects.toEqual(expect.objectContaining({ name: "RpcError", code: 99, message: "Expected failure" }));
    client.close();
  });

  it("reports an unexpected socket disconnect but not an explicit close", async () => {
    const client = new CodexClient("ws://127.0.0.1:4500", 1_000);
    const disconnected = vi.fn();
    client.onDisconnect(disconnected);
    await client.connect();

    FakeWebSocket.instances[0]!.close();
    expect(disconnected).toHaveBeenCalledTimes(1);

    await client.connect();
    client.close();
    expect(disconnected).toHaveBeenCalledTimes(1);
  });

  it("rejects server-initiated requests with string IDs instead of leaving them pending", async () => {
    const client = new CodexClient("ws://127.0.0.1:4500", 1_000);
    await client.connect();
    const socket = FakeWebSocket.instances[0]!;

    socket.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({ id: "approval-1", method: "item/permissions/requestApproval", params: {} }),
    }));

    expect(socket.sent.at(-1)).toMatchObject({
      id: "approval-1",
      error: { code: -32601 },
    });
    client.close();
  });
});
