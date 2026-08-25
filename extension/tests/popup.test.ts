import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it, vi } from "vitest";
import type { RuntimeRequest, RuntimeResponse } from "../src/shared/messages";
import type { ConnectionState } from "../src/shared/models";

const popupHtml = readFileSync(resolve(import.meta.dirname, "../src/popup/popup.html"), "utf8");
const settings = {
  endpoint: "ws://127.0.0.1:4500",
  projectRoot: null,
  openOnCompletion: true,
};

function installPopupDocument(): void {
  document.open();
  document.write(popupHtml);
  document.close();
}

const flush = async () => {
  await new Promise((resolveFlush) => setTimeout(resolveFlush, 0));
};

function installChrome(connection: ConnectionState) {
  const sendMessage = vi.fn(async (message: RuntimeRequest): Promise<RuntimeResponse> => {
    if (message.type === "GET_SETUP_STATE") return { ok: true, settings, connection };
    if (message.type === "CHECK_CONNECTION") {
      return { ok: true, connection: { status: "online", endpoint: settings.endpoint } };
    }
    return { ok: true, settings };
  });
  Object.assign(globalThis, {
    chrome: { runtime: { id: "abcdefghijklmnopabcdefghijklmnop", sendMessage } },
  });
  return sendMessage;
}

it("renders the X-native connected state and toggles recovery help", async () => {
  vi.resetModules();
  installPopupDocument();
  installChrome({ status: "online", endpoint: settings.endpoint });

  await import("../src/popup/popup");
  await flush();

  expect(document.getElementById("setup-shell")?.dataset.connection).toBe("online");
  expect(document.getElementById("hero-title")?.textContent).toBe("Ready to weave");
  expect(document.getElementById("recovery-row")?.hidden).toBe(true);
  expect(document.getElementById("advanced-button")?.hidden).toBe(false);
  expect(document.getElementById("done-button")?.textContent).toBe("Done");

  document.getElementById("help-button")?.click();
  expect(document.getElementById("recovery-row")?.hidden).toBe(false);
  expect(document.getElementById("save-status")?.textContent).toBe("Hide recovery steps");
});

it("renders recovery when offline and retries the connection", async () => {
  vi.resetModules();
  installPopupDocument();
  const sendMessage = installChrome({
    status: "offline",
    endpoint: settings.endpoint,
    errorSummary: "Connection refused",
  });

  await import("../src/popup/popup");
  await flush();

  expect(document.getElementById("setup-shell")?.dataset.connection).toBe("offline");
  expect(document.getElementById("hero-title")?.textContent).toBe("Reconnect Weaver");
  expect(document.getElementById("recovery-row")?.hidden).toBe(false);
  expect(document.getElementById("advanced-button")?.hidden).toBe(false);
  expect(document.getElementById("done-button")?.textContent).toBe("Try again");

  document.getElementById("advanced-button")?.click();
  expect(document.getElementById("advanced-panel")?.hidden).toBe(false);

  document.getElementById("done-button")?.click();
  await flush();

  expect(sendMessage).toHaveBeenCalledWith({ type: "CHECK_CONNECTION" });
  expect(document.getElementById("setup-shell")?.dataset.connection).toBe("online");
  expect(document.getElementById("done-button")?.textContent).toBe("Done");
});

it("rejects an invalid endpoint before rendering or sending it", async () => {
  vi.resetModules();
  installPopupDocument();
  const sendMessage = installChrome({ status: "online", endpoint: settings.endpoint });

  await import("../src/popup/popup");
  await flush();

  document.getElementById("advanced-button")?.click();
  const endpointInput = document.getElementById("endpoint-input") as HTMLInputElement;
  endpointInput.value = "not-a-websocket-url";
  endpointInput.dispatchEvent(new Event("change"));
  await flush();

  expect(endpointInput.value).toBe(settings.endpoint);
  expect(document.getElementById("form-error")?.textContent).toContain("valid WebSocket URL");
  expect(document.getElementById("save-status")?.textContent).toBe("Could not save");
  expect(sendMessage.mock.calls.some(([message]) => message.type === "SAVE_SETTINGS")).toBe(false);
});

it("waits for an offline endpoint change to save before retrying", async () => {
  vi.resetModules();
  installPopupDocument();
  const sendMessage = installChrome({ status: "offline", endpoint: settings.endpoint });
  let finishSave: ((response: RuntimeResponse) => void) | undefined;
  sendMessage.mockImplementation(async (message: RuntimeRequest): Promise<RuntimeResponse> => {
    if (message.type === "GET_SETUP_STATE") {
      return { ok: true, settings, connection: { status: "offline", endpoint: settings.endpoint } };
    }
    if (message.type === "SAVE_SETTINGS") {
      return new Promise((resolveSave) => { finishSave = resolveSave; });
    }
    if (message.type === "CHECK_CONNECTION") {
      return { ok: true, connection: { status: "online", endpoint: "ws://127.0.0.1:4600" } };
    }
    return { ok: true };
  });

  await import("../src/popup/popup");
  await flush();

  document.getElementById("advanced-button")?.click();
  const endpointInput = document.getElementById("endpoint-input") as HTMLInputElement;
  endpointInput.value = "ws://127.0.0.1:4600";
  endpointInput.dispatchEvent(new Event("change"));
  document.getElementById("done-button")?.click();
  await flush();

  expect(sendMessage.mock.calls.some(([message]) => message.type === "SAVE_SETTINGS")).toBe(true);
  expect(sendMessage.mock.calls.some(([message]) => message.type === "CHECK_CONNECTION")).toBe(false);

  finishSave?.({ ok: true, settings: { ...settings, endpoint: "ws://127.0.0.1:4600" } });
  await flush();
  await flush();

  const requestTypes = sendMessage.mock.calls.map(([message]) => message.type);
  expect(requestTypes.indexOf("SAVE_SETTINGS")).toBeLessThan(requestTypes.indexOf("CHECK_CONNECTION"));
  expect(document.getElementById("setup-shell")?.dataset.connection).toBe("online");
});
