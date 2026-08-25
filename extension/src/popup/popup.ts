import type { RuntimeRequest, RuntimeResponse } from "../shared/messages";
import type { ConnectionState, WeaverSettings } from "../shared/models";
import { backendStartCommand } from "../shared/constants";
import { validateSettings } from "../shared/validation";

type UiConnectionStatus = ConnectionState["status"] | "checking";

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing setup element: ${id}`);
  return element as T;
};

let settings: WeaverSettings | null = null;
let saveQueue = Promise.resolve();
let settingsRevision = 0;
let lastSaveSucceeded = true;
let connectionStatus: UiConnectionStatus = "checking";
let showRecoveryHelp = false;

function request(message: RuntimeRequest): Promise<RuntimeResponse> {
  return chrome.runtime.sendMessage(message) as Promise<RuntimeResponse>;
}

function endpointLabel(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return url.host || endpoint;
  } catch {
    return endpoint.replace(/^wss?:\/\//, "");
  }
}

function setError(message?: string): void {
  const element = byId("form-error");
  element.hidden = !message;
  element.textContent = message ?? "";
}

function setFooter(title: string, detail: string): void {
  byId("footer-title").textContent = title;
  byId("save-status").textContent = detail;
}

function renderSettings(next: WeaverSettings): void {
  settings = next;
  byId("project-value").textContent = next.projectRoot ?? "Discovered on first weave";
  byId<HTMLInputElement>("project-input").value = next.projectRoot ?? "";
  byId<HTMLInputElement>("endpoint-input").value = next.endpoint;
  byId<HTMLInputElement>("open-input").checked = next.openOnCompletion;
  byId("endpoint-value").textContent = endpointLabel(next.endpoint);
  const command = backendStartCommand(chrome.runtime.id, next.endpoint);
  const commandElement = byId("start-command");
  commandElement.textContent = command;
  commandElement.title = command;
}

function renderRecoveryVisibility(): void {
  const online = connectionStatus === "online";
  const checking = connectionStatus === "checking";
  const advancedButton = byId<HTMLButtonElement>("advanced-button");
  const advancedPanel = byId("advanced-panel");
  const recoveryRow = byId("recovery-row");
  const helpButton = byId<HTMLButtonElement>("help-button");

  advancedButton.hidden = checking;
  if (checking) {
    advancedPanel.hidden = true;
    advancedButton.setAttribute("aria-expanded", "false");
  }
  recoveryRow.hidden = checking || (online && !showRecoveryHelp);
  helpButton.disabled = !online;
  helpButton.setAttribute("aria-expanded", String(online && showRecoveryHelp));
}

function renderCheckingConnection(): void {
  connectionStatus = "checking";
  byId("setup-shell").dataset.connection = "checking";
  byId("hero-status").textContent = "Checking";
  byId("hero-title").textContent = "Checking Weaver";
  byId("hero-description").textContent = "Confirming the local backend connection.";
  const statusButton = byId<HTMLButtonElement>("refresh-connection");
  delete statusButton.dataset.status;
  statusButton.title = "Check connection again";
  byId("connection-value").textContent = "Checking";
  const doneButton = byId<HTMLButtonElement>("done-button");
  doneButton.textContent = "Checking";
  doneButton.disabled = true;
  setFooter("Checking backend", "Connecting locally…");
  renderRecoveryVisibility();
}

function renderConnection(connection: ConnectionState): void {
  connectionStatus = connection.status;
  byId("setup-shell").dataset.connection = connection.status;
  byId("endpoint-value").textContent = endpointLabel(connection.endpoint);

  const statusButton = byId<HTMLButtonElement>("refresh-connection");
  statusButton.dataset.status = connection.status;
  const doneButton = byId<HTMLButtonElement>("done-button");
  doneButton.disabled = false;

  if (connection.status === "online") {
    statusButton.title = "Check connection again";
    byId("hero-status").textContent = "Connected";
    byId("hero-title").textContent = "Ready to weave";
    byId("hero-description").textContent =
      "Hover any post on X, then select the Weaver action to start a Codex project.";
    byId("connection-value").textContent = "Connected";
    doneButton.textContent = "Done";
    setFooter("Need help?", showRecoveryHelp ? "Hide recovery steps" : "View recovery steps");
  } else {
    showRecoveryHelp = false;
    byId("hero-status").textContent = "Offline";
    byId("hero-title").textContent = "Reconnect Weaver";
    byId("hero-description").textContent =
      "Start the local backend below. Weaver will reconnect automatically.";
    byId("connection-value").textContent = "Offline";
    statusButton.title = connection.errorSummary
      ? `Check connection again: ${connection.errorSummary}`
      : "Check connection again";
    doneButton.textContent = "Try again";
    setFooter("Backend stopped", "Start it, then try again");
  }

  renderRecoveryVisibility();
}

function queueSettingsSave(changes: Partial<WeaverSettings>): void {
  if (!settings) return;
  const revision = ++settingsRevision;
  let next: WeaverSettings;
  try {
    next = validateSettings({ ...settings, ...changes });
  } catch (error) {
    lastSaveSucceeded = false;
    renderSettings(settings);
    setError(error instanceof Error ? error.message : String(error));
    byId("save-status").textContent = "Could not save";
    return;
  }
  renderSettings(next);
  setError();
  lastSaveSucceeded = true;
  byId("save-status").textContent = "Saving…";
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
  renderCheckingConnection();
  try {
    const response = await request({ type: "CHECK_CONNECTION" });
    if (response.connection) {
      setError(response.ok ? undefined : response.error);
      renderConnection(response.connection);
      return;
    }

    const endpoint = settings?.endpoint ?? "ws://127.0.0.1:4500";
    const error = response.ok ? "The Weaver backend did not return a connection state." : response.error;
    setError(error);
    renderConnection({ status: "offline", endpoint, errorSummary: error });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setError(message);
    renderConnection({
      status: "offline",
      endpoint: settings?.endpoint ?? "ws://127.0.0.1:4500",
      errorSummary: message,
    });
  }
}

async function refreshAfterPendingSaves(): Promise<void> {
  await saveQueue;
  if (!lastSaveSucceeded) {
    byId<HTMLButtonElement>("done-button").disabled = false;
    return;
  }
  await refreshConnection();
}

async function initialize(): Promise<void> {
  renderCheckingConnection();
  const response = await request({ type: "GET_SETUP_STATE" });
  if (!response.ok) throw new Error(response.error);
  if (response.settings) renderSettings(response.settings);
  if (response.connection) renderConnection(response.connection);
}

byId("close-button").addEventListener("click", () => window.close());

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

byId("help-button").addEventListener("click", () => {
  if (connectionStatus !== "online") return;
  showRecoveryHelp = !showRecoveryHelp;
  renderRecoveryVisibility();
  setFooter("Need help?", showRecoveryHelp ? "Hide recovery steps" : "View recovery steps");
});

byId("refresh-connection").addEventListener("click", () => { void refreshAfterPendingSaves(); });
byId<HTMLButtonElement>("done-button").addEventListener("click", () => {
  const button = byId<HTMLButtonElement>("done-button");
  if (connectionStatus !== "online") {
    button.disabled = true;
    void refreshAfterPendingSaves();
    return;
  }

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
  const message = error instanceof Error ? error.message : String(error);
  setError(message);
  renderConnection({
    status: "offline",
    endpoint: settings?.endpoint ?? "ws://127.0.0.1:4500",
    errorSummary: message,
  });
});
