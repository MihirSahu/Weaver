import type { PostContext } from "../shared/models";
import type { CodexClient, InitializeResult } from "./codex-client";

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface DirectoryEntries {
  entries: Array<{ fileName: string; isDirectory: boolean; isFile: boolean }>;
}

interface PathMetadata {
  isDirectory: boolean;
  isFile: boolean;
  isSymlink: boolean;
}

interface FileContents {
  dataBase64: string;
}

const PROJECT_MARKER = ".weaver-project.json";

export interface CreatedProject {
  projectName: string;
  projectPath: string;
  projectRoot: string;
}

export function createProjectSlug(text: string, postId: string): string {
  if (!/^\d+$/.test(postId)) throw new Error("Post ID must be numeric.");
  const words = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "") || "weave";
  return `${words}-${postId}`;
}

export function isAbsoluteHostPath(path: string, windows: boolean): boolean {
  return windows ? /^[A-Za-z]:[\\/][^\0]*$/.test(path) : /^\/[^\0]*$/.test(path);
}

function separator(windows: boolean): "\\" | "/" {
  return windows ? "\\" : "/";
}

function trimSeparators(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

function joinHostPath(parent: string, child: string, windows: boolean): string {
  return `${trimSeparators(parent)}${separator(windows)}${child}`;
}

function sameFileName(left: string, right: string, windows: boolean): boolean {
  return windows ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function parentHostPath(path: string, windows: boolean): string {
  const hostSeparator = separator(windows);
  const normalized = trimSeparators(path).replace(/[\\/]+/g, hostSeparator);
  const boundary = normalized.lastIndexOf(hostSeparator);
  if (boundary < 0) throw new Error("The persisted Weaver project path has no parent directory.");
  const parent = normalized.slice(0, boundary);
  if (!windows && parent === "") return "/";
  if (windows && /^[A-Za-z]:$/.test(parent)) return `${parent}\\`;
  return parent;
}

function comparable(path: string, windows: boolean): string {
  const value = trimSeparators(path).replace(/[\\/]+/g, separator(windows));
  return windows ? value.toLowerCase() : value;
}

export function assertDirectChild(root: string, child: string, windows: boolean): void {
  const normalizedRoot = comparable(root, windows);
  const normalizedChild = comparable(child, windows);
  const prefix = `${normalizedRoot}${separator(windows)}`;
  if (!normalizedChild.startsWith(prefix) || normalizedChild.slice(prefix.length).includes(separator(windows))) {
    throw new Error("Project path must remain a direct child of the Weaver root.");
  }
}

async function run(client: CodexClient, command: string[]): Promise<CommandResult> {
  const result = await client.request<CommandResult>("command/exec", {
    command,
    timeoutMs: 30_000,
    sandboxPolicy: { type: "readOnly", networkAccess: false },
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Command failed: ${command[0]}`);
  return result;
}

async function discoverHome(client: CodexClient, platform: InitializeResult): Promise<{ home: string; windows: boolean }> {
  const windows = `${platform.platformFamily ?? ""} ${platform.platformOs ?? ""}`.toLowerCase().includes("windows");
  const command = windows
    ? ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "[Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)"]
    : ["sh", "-c", "printf '%s' \"$HOME\""];
  const result = await run(client, command);
  const home = result.stdout.trim();
  if (!isAbsoluteHostPath(home, windows)) throw new Error("Codex returned an invalid home directory.");
  return { home, windows };
}

function projectMarkerContents(post: PostContext, project: CreatedProject): string {
  return `${JSON.stringify({ version: 1, postId: post.postId, projectName: project.projectName }, null, 2)}\n`;
}

function encodeBase64(value: string): string {
  return btoa(value);
}

function decodeBase64(value: string): string {
  return atob(value);
}

async function writeProjectMarker(client: CodexClient, project: CreatedProject, post: PostContext, windows: boolean): Promise<void> {
  await client.request("fs/writeFile", {
    path: joinHostPath(project.projectPath, PROJECT_MARKER, windows),
    dataBase64: encodeBase64(projectMarkerContents(post, project)),
  });
}

async function verifyOrClaimProjectDirectory(
  client: CodexClient,
  project: CreatedProject,
  post: PostContext,
  windows: boolean,
): Promise<void> {
  const contents = await client.request<DirectoryEntries>("fs/readDirectory", { path: project.projectPath });
  const marker = contents.entries.find((entry) => sameFileName(entry.fileName, PROJECT_MARKER, windows));
  if (!marker) {
    // A disconnected create can leave an empty directory before its marker is
    // written. Claim only that empty partial result; never adopt user content.
    if (contents.entries.length > 0) {
      throw new Error(`The persisted Weaver project directory is not owned by Weaver: ${project.projectPath}`);
    }
    await writeProjectMarker(client, project, post, windows);
    return;
  }
  if (!marker.isFile || marker.isDirectory) {
    throw new Error(`The persisted Weaver project marker is not a regular file: ${project.projectPath}`);
  }
  const markerPath = joinHostPath(project.projectPath, marker.fileName, windows);
  const metadata = await client.request<PathMetadata>("fs/getMetadata", { path: markerPath });
  if (!metadata.isFile || metadata.isDirectory || metadata.isSymlink) {
    throw new Error(`The persisted Weaver project marker is unsafe: ${project.projectPath}`);
  }
  const stored = await client.request<FileContents>("fs/readFile", { path: markerPath });
  if (decodeBase64(stored.dataBase64) !== projectMarkerContents(post, project)) {
    throw new Error(`The persisted Weaver project marker does not match this post: ${project.projectPath}`);
  }
}

export async function prepareProject(
  client: CodexClient,
  platform: InitializeResult,
  post: PostContext,
  configuredRoot: string | null,
  existingProjectPath?: string,
  onPlanned?: (project: CreatedProject) => Promise<void>,
): Promise<CreatedProject> {
  const discovered = await discoverHome(client, platform);
  const configuredProjectRoot = configuredRoot?.trim() || joinHostPath(discovered.home, "Weaver", discovered.windows);
  const projectRoot = existingProjectPath
    ? parentHostPath(existingProjectPath, discovered.windows)
    : configuredProjectRoot;
  if (!isAbsoluteHostPath(projectRoot, discovered.windows)) throw new Error("The Weaver project root must be an absolute local path.");
  const projectName = createProjectSlug(post.text, post.postId);
  const projectPath = existingProjectPath || joinHostPath(projectRoot, projectName, discovered.windows);
  assertDirectChild(projectRoot, projectPath, discovered.windows);
  const project = { projectName: trimSeparators(projectPath).split(/[\\/]/).at(-1) ?? projectName, projectPath, projectRoot };

  await client.request("fs/createDirectory", { path: projectRoot, recursive: true });
  const listing = await client.request<DirectoryEntries>("fs/readDirectory", { path: projectRoot });
  const existingName = project.projectName;
  const collision = listing.entries.find((entry) => sameFileName(entry.fileName, existingName, discovered.windows));
  if (collision && !existingProjectPath) throw new Error(`A project named ${existingName} already exists. Weaver will not reuse it.`);
  if (collision) {
    if (!collision.isDirectory || collision.isFile) {
      throw new Error(`The persisted Weaver project path is not a directory: ${projectPath}`);
    }
    const metadata = await client.request<PathMetadata>("fs/getMetadata", { path: projectPath });
    if (!metadata.isDirectory || metadata.isFile || metadata.isSymlink) {
      throw new Error(`The persisted Weaver project path is not a safe directory: ${projectPath}`);
    }
  }
  // Persist the deterministic path after ruling out unrelated collisions but
  // before creating it, so a disconnected create request remains retryable.
  await onPlanned?.(project);
  if (!collision) {
    await client.request("fs/createDirectory", { path: projectPath, recursive: false });
    await writeProjectMarker(client, project, post, discovered.windows);
  } else {
    await verifyOrClaimProjectDirectory(client, project, post, discovered.windows);
  }
  return project;
}

export function createThreadTitle(post: PostContext): string {
  const title = post.text.replace(/\s+/g, " ").trim().slice(0, 60).trim();
  return `Build: ${title || `X post ${post.postId}`}`;
}

export function createWorkspacePolicy(projectPath: string) {
  return {
    type: "workspaceWrite" as const,
    writableRoots: [projectPath],
    networkAccess: true,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  };
}
