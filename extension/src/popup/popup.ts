import type { RuntimeRequest, RuntimeResponse } from "../shared/messages";
import type { ConnectionState, WeaverSettings } from "../shared/models";
import { appServerStartCommand } from "../shared/constants";

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing setup element: ${id}`);
  return element as T;
};

let settings: WeaverSettings | null = null;
let saveQueue = Promise.resolve();
let settingsRevision = 0;
let lastSaveSucceeded = true;

function request(message: RuntimeRequest): Promise<RuntimeResponse> {
  return chrome.runtime.sendMessage(message) as Promise<RuntimeResponse>;
}

function setError(message?: string): void {
  const element = byId("form-error");
  element.hidden = !message;
  element.textContent = message ?? "";
}

function renderSettings(next: WeaverSettings): void {
  settings = next;
  byId("project-value").textContent = next.projectRoot ?? "Discovered on first weave";
  byId<HTMLInputElement>("project-input").value = next.projectRoot ?? "";
  byId<HTMLInputElement>("endpoint-input").value = next.endpoint;
  byId<HTMLInputElement>("open-input").checked = next.openOnCompletion;
  byId("start-command").textContent = appServerStartCommand(next.endpoint);
}

function renderConnection(connection: ConnectionState): void {
  const button = byId<HTMLButtonElement>("refresh-connection");
  button.dataset.status = connection.status;
  byId("connection-value").textContent = connection.status === "online" ? "Connected locally" : "Codex is offline";
}

function queueSettingsSave(changes: Partial<WeaverSettings>): void {
  if (!settings) return;
  const next = { ...settings, ...changes };
  const revision = ++settingsRevision;
  renderSettings(next);
  setError();
  lastSaveSucceeded = true;
  byId("save-status").textContent = "Saving...";
  saveQueue = saveQueue.then(async () => {
    const response = await request({ type: "SAVE_SETTINGS", changes });
    if (revision !== settingsRevision) return;
    if (!response.ok) {
      lastSaveSucceeded = false;
      setError(response.error);
      byId("save-status").textContent = "Could not save";
      return;
    }
    renderSettings(response.settings ?? next);
    lastSaveSucceeded = true;
    byId("save-status").textContent = "Changes saved automatically";
  }).catch((error) => {
    if (revision !== settingsRevision) return;
    lastSaveSucceeded = false;
    setError(error instanceof Error ? error.message : String(error));
    byId("save-status").textContent = "Could not save";
  });
}

async function refreshConnection(): Promise<void> {
  byId("connection-value").textContent = "Checking locally...";
  const response = await request({ type: "CHECK_CONNECTION" });
  if (response.connection) renderConnection(response.connection);
}

async function initialize(): Promise<void> {
  const response = await request({ type: "GET_SETUP_STATE" });
  if (!response.ok) throw new Error(response.error);
  if (response.settings) renderSettings(response.settings);
  if (response.connection) renderConnection(response.connection);
}

byId("change-project").addEventListener("click", () => {
  byId("project-display-row").hidden = true;
  const input = byId<HTMLInputElement>("project-input");
  input.hidden = false;
  input.focus();
  input.select();
});

const projectInput = byId<HTMLInputElement>("project-input");
projectInput.addEventListener("blur", () => {
  projectInput.hidden = true;
  byId("project-display-row").hidden = false;
  queueSettingsSave({ projectRoot: projectInput.value.trim() || null });
});

projectInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") projectInput.blur();
  if (event.key === "Escape") {
    projectInput.value = settings?.projectRoot ?? "";
    projectInput.blur();
  }
});

byId("advanced-button").addEventListener("click", () => {
  const panel = byId("advanced-panel");
  panel.hidden = !panel.hidden;
  byId("advanced-button").setAttribute("aria-expanded", String(!panel.hidden));
});

const endpointInput = byId<HTMLInputElement>("endpoint-input");
endpointInput.addEventListener("change", () => {
  queueSettingsSave({ endpoint: endpointInput.value.trim() });
});

const openInput = byId<HTMLInputElement>("open-input");
openInput.addEventListener("change", () => {
  queueSettingsSave({ openOnCompletion: openInput.checked });
});

byId("refresh-connection").addEventListener("click", () => { void refreshConnection(); });
byId<HTMLButtonElement>("done-button").addEventListener("click", () => {
  const button = byId<HTMLButtonElement>("done-button");
  button.disabled = true;
  void saveQueue.then(() => {
    if (lastSaveSucceeded) window.close();
    else button.disabled = false;
  });
});
const copyButton = byId<HTMLButtonElement>("copy-command");
copyButton.addEventListener("click", async () => {
  const command = byId("start-command").textContent ?? "";
  try {
    await navigator.clipboard.writeText(command);
    copyButton.textContent = "Copied";
    window.setTimeout(() => { copyButton.textContent = "Copy"; }, 1_200);
  } catch {
    const range = document.createRange();
    range.selectNodeContents(byId("start-command"));
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
  }
});

void initialize().catch((error) => {
  setError(error instanceof Error ? error.message : String(error));
  renderConnection({ status: "offline", endpoint: "ws://127.0.0.1:4500" });
});
