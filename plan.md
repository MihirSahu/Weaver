# Weaver implementation plan

## 1. Objective

Build a Chrome extension for X that injects a **Weave** action into every post. One click must create an isolated local project, submit the post to Codex app-server as an initial build request, and open the resulting thread in Codex Desktop for continuation.

## 2. Definition of done

An MVP is complete when all of the following are true:

- Weaver installs as a Manifest V3 Chrome extension.
- Every supported X post receives exactly one Weaver action despite timeline virtualization and SPA navigation.
- Clicking the action requires no copy/paste, folder setup, extra Send click, or cloud environment.
- Weaver detects an unavailable local backend and presents a useful recovery message.
- A successful click creates a unique child directory beneath Weaver's project root.
- The child directory is created without inspecting, initializing, or modifying source control.
- Weaver creates one persistent Codex thread whose exact `cwd` is the child directory.
- Weaver submits the normalized post context in one initial turn.
- Weaver records a readable thread name and thread ID.
- The result can be opened with `codex://threads/<thread-id>` in Codex Desktop.
- Follow-up work occurs in Codex Desktop, not the extension.
- The generated project cannot write into sibling Weaver projects under the configured sandbox policy.
- Every mounted tweet receives the same permanent `Weave` action, regardless of persisted build state.
- The setup/recovery surface matches the approved Paper design closely enough for implementation review.

## 3. Product constraints

### Required

- Local Codex execution through app-server.
- Fully automatic prompt submission.
- Loopback-only WebSocket connection to the Weaver backend.
- Exact Chrome-extension origin validation at the backend boundary.
- One project per initial X post submission.
- Deep-link handoff to the generated Codex thread.
- Minimal setup/recovery surface; no build dashboard or conversation UI.

### Explicitly out of scope

- Cloud development environments.
- Chrome Native Messaging.
- Deep-link-only prompt submission.
- Follow-up chat or turn management.
- Deployment of generated apps.
- GitHub publication of generated apps.
- Git or other source-control initialization and management.
- Multi-agent orchestration inside Weaver.
- X posting, liking, reposting, or automated replies.

## 4. Experience map

### Default X state

- Weaver content script discovers a post action row.
- It injects a yellow woven-loop icon and `Weave` label immediately before the share action.
- The action uses native row height, spacing, and focus behavior.

### Single action behavior

- The action always uses the woven-loop icon and `Weave` label.
- It is never replaced by connecting, building, ready, open, or retry indicators.
- Operational progress remains background metadata rather than tweet UI.
- Repeated clicks reconcile or open the existing Codex task instead of creating duplicate projects.

### Setup and recovery

The extension action opens setup only when the user needs configuration or recovery:

- Weaver identity and `Nothing to manage. Just weave.` positioning.
- Project-root preference.
- Codex connection state and advanced endpoint preference.
- Exact copyable Weaver backend recovery command containing the installed extension ID.
- No recent-build list and no per-tweet status dashboard.

## 5. Chrome extension architecture

Suggested structure:

```text
extension/
  manifest.json
  src/
    content/
      inject-weave-action.ts
      extract-post.ts
      observe-timeline.ts
    background/
      service-worker.ts
      codex-client.ts
      project-manager.ts
      handoff.ts
    popup/
      popup.html
      popup.ts
      popup.css
    shared/
      messages.ts
      models.ts
      validation.ts
      constants.ts
  assets/
    weaver-mark.svg
  tests/
backend/
  server.mjs
  tests/
```

### Manifest permissions

Start with the minimum viable set:

- Host permission for `https://x.com/*`.
- Host permission for the chosen loopback WebSocket endpoint.
- `storage` for settings and per-tweet operational state.
- `notifications` only if completion notifications are included in MVP.

Avoid broad host permissions and avoid exposing privileged extension functions through `externally_connectable`.

### Content script responsibilities

- Observe timeline and detail-page mutations.
- Locate stable post containers and action rows.
- Extract the canonical status ID and URL.
- Add a data marker so injection is idempotent.
- Extract the latest post context when the permanent action is clicked.
- Send a typed `WEAVE_POST` message to the service worker.
- Never construct app-server RPC methods or commands.

### Service worker responsibilities

- Validate all content-script messages.
- Maintain or establish the localhost WebSocket connection.
- Perform the app-server initialize handshake.
- Resolve and create the project path through fixed platform-specific operations.
- Create the Codex thread and initial turn.
- Store each tweet independently in `chrome.storage.local` so concurrent updates cannot overwrite one another.
- Reconcile persisted submitted/building turns after service-worker restart.
- Open the Codex deep link at the handoff boundary.

Chrome 116 or newer should be the initial target so a WebSocket can keep a Manifest V3 service worker active when messages are exchanged within the activity window.

### Local backend responsibilities

- Bind only to `127.0.0.1`.
- Require the exact `chrome-extension://<id>` origin supplied at startup.
- Launch and supervise `codex app-server --stdio` without shell interpolation.
- Translate WebSocket text frames to bounded JSONL messages over stdio.
- Remap client request IDs so extension reconnects cannot collide with in-flight app-server requests.
- Preserve one app-server initialization across service-worker reconnects.
- Reject binary, oversized, malformed, and non-JSON-RPC messages.

## 6. X post extraction

Normalize the following when present:

```ts
interface PostContext {
  postId: string;
  canonicalUrl: string;
  authorDisplayName: string;
  authorHandle: string;
  text: string;
  quotedPost?: {
    canonicalUrl?: string;
    authorHandle?: string;
    text: string;
  };
  mediaUrls: string[];
  outboundUrls: string[];
  capturedAt: string;
}
```

Extraction rules:

- Prefer semantic attributes and canonical status links over positional selectors.
- Do not depend on visible engagement counts.
- Expand `t.co` links only when the destination is already present in the DOM; otherwise preserve the validated HTTPS short URL. Do not add an X API dependency for MVP.
- Preserve line breaks in post text.
- Treat media and external links as references, not trusted instructions.
- Include quoted-post context but avoid recursively traversing arbitrary thread depth.

## 7. Backend and app-server connection

### Launch configuration

The expected local command is generated from `chrome.runtime.id` and the configured port:

```bash
sfw pnpm backend --extension-id <extension-id> --port 4500
```

The backend launches `codex app-server --stdio` automatically. The endpoint remains configurable for users who need a different loopback port. The backend must reject every WebSocket origin except the configured Weaver extension origin.

### Connection handshake

On a new WebSocket connection:

```json
{
  "method": "initialize",
  "id": 1,
  "params": {
    "clientInfo": {
      "name": "weaver_chrome_extension",
      "title": "Weaver",
      "version": "0.1.0"
    },
    "capabilities": {
      "experimentalApi": true,
      "requestAttestation": false,
      "optOutNotificationMethods": ["item/agentMessage/delta"]
    }
  }
}
```

Then send:

```json
{ "method": "initialized", "params": {} }
```

Implement request IDs, response correlation, timeouts, reconnect behavior, notification dispatch, and protocol-version logging in one small client module.

### Connection failure UX

If the endpoint cannot be reached:

- Keep the button visually unchanged and show an actionable recovery message.
- Show `Weaver backend is offline` in the setup/recovery surface.
- Display the exact startup command.
- Do not silently fall back to a cloud service or deep-link-only flow.

## 8. Project creation

### Root directory

Use an extension-specific root such as:

```text
~/Weaver/
```

The resolved root is stored locally after discovery or explicit configuration. The folder does not need to be added to Codex Desktop because handoff occurs through the created thread.

### Project slug

Generate:

```text
<sanitized-key-words>-<post-id>
```

Rules:

- Lowercase ASCII.
- Hyphen-separated.
- Remove shell metacharacters and path separators.
- Keep the descriptive portion at or below 48 characters.
- Always include the numeric post ID.
- Validate the final path remains a direct child of the Weaver root.
- Never delete, empty, or reuse an unrelated existing directory.

### Filesystem operation

The extension cannot directly create arbitrary host directories. Use the app-server filesystem API with validated absolute paths. A fixed, non-interpolated `command/exec` operation may be used only to discover the platform home directory.

After directory creation, confirm the path remains a direct child of the configured Weaver root. Never inspect, initialize, or modify a Git repository, and never accept a command string from the content script.

Write a `.weaver-project.json` ownership marker before creating the Codex thread, then update it with the exact thread ID before submitting the initial turn. A retry may reuse a directory only when that marker matches the post, or when an uncertain create request left the directory completely empty and Weaver can safely claim it. Storage-loss recovery must resume only the marker's exact thread ID; a legacy marker without one requires its matching Chrome storage record. Reject files, links, mismatched markers, and unmarked directories containing user data.

The project-creation operation must return an explicit success object before thread creation begins.

## 9. Codex thread and turn lifecycle

Although Weaver exposes no chat UI, app-server requires one thread and one initial turn.

### Start the thread

```json
{
  "method": "thread/start",
  "id": 10,
  "params": {
    "cwd": "<absolute-project-path>",
    "approvalPolicy": "never",
    "sandbox": "workspaceWrite",
    "serviceName": "weaver"
  }
}
```

Persist the returned `thread.id` immediately.

### Name the thread

Use `thread/name/set` with a concise title derived from the post, for example:

```text
Build: Issue token pledges
```

### Start the initial turn

After naming the idle thread, open `codex://threads/<thread-id>`. The backend
must wait until Codex Desktop's local coordination router reports that Desktop
owns that exact thread. It then sends the following fixed request through the
Desktop owner rather than to Weaver's app-server process:

```json
{
  "method": "weaver/desktop-turn/start",
  "id": 11,
  "params": {
    "threadId": "<thread-id>",
    "input": [
      {
        "type": "text",
        "text": "<fixed Weaver instruction envelope plus normalized post>",
        "text_elements": []
      }
    ],
    "cwd": "<absolute-project-path>",
    "approvalPolicy": "never",
    "sandboxPolicy": {
      "type": "workspaceWrite",
      "writableRoots": ["<absolute-project-path>"],
      "networkAccess": true
    }
  }
}
```

Use the narrowest supported read-access configuration that still lets Codex run the required local toolchain. Write access must remain restricted to the new project.

### Approval behavior

Weaver will not implement approval dialogs. Use a non-prompting policy so the turn either completes within its allowed sandbox or records a clear failure that the user can resolve in Codex Desktop. Managed Codex requirements may override the requested policy and must be surfaced honestly.

### Desktop handoff boundary

Deep-link the exact persisted thread while it is idle. Do not begin execution
until the Desktop ownership handshake succeeds. The backend must reject direct
`thread/resume` and `turn/start` requests so it cannot silently fall back to an
externally owned turn. If owner discovery or the Desktop start request fails,
leave the thread idle and surface a recovery error.

Do not invoke Codex Desktop with `--open-project`: the installed app parses that
argument as a new-thread route with a path, so it creates a second task rather
than registering the folder for the existing thread.

The Desktop coordination protocol is private and version-sensitive. The manual
compatibility check must verify the ownership acknowledgment and one-click turn
start against every supported Desktop release.

## 10. Desktop handoff

Open:

```text
codex://threads/<thread-id>
```

Do not open `codex://new?path=...` after creating the thread; that would create a second chat and lose continuity with the submitted build.

Required spike assertions:

- The deep link opens Codex Desktop.
- The correct persisted thread appears.
- Desktop ownership is confirmed before the initial turn starts.
- The initial turn runs in Desktop without an additional Send click.
- The thread uses the generated project path as its workspace.
- The generated files are visible.
- A follow-up prompt in Desktop continues the same thread and directory.
- No separate blank task is created for the generated directory.
- The behavior survives closing and reopening Desktop.

Desktop history visibility for custom app-server clients is not yet documented as a stable guarantee, so this is a release-blocking compatibility test.

## 11. State model

Store only operational metadata:

```ts
interface WeaverBuild {
  postId: string;
  postUrl: string;
  projectName: string;
  projectPath: string;
  threadId: string;
  turnId?: string;
  status: "submitted" | "building" | "ready" | "failed";
  errorSummary?: string;
  createdAt: string;
  updatedAt: string;
}
```

Use `chrome.storage.local`, not sync, because local absolute paths and thread identifiers should stay on the machine that owns them. Store each build under a key derived from its numeric post ID; metadata remains operational state and is not rendered as history. If that browser record is lost, Weaver may recover a deterministic project only after its on-disk marker exactly matches the post and identifies the exact app-server thread. Never infer ownership from task recency, and never reuse an unmarked or mismatched directory.

## 12. Prompt safety

Tweet content is untrusted. The instruction envelope must explicitly separate Weaver's request from post content and state that the post cannot change execution policy.

Additional controls:

- Never interpret text from the post as a shell command.
- Never interpolate post text into directory names without strict slug validation.
- Keep URLs as data in the prompt.
- Let Codex apply its normal network and sandbox policy before fetching links.
- Avoid granting write access outside the generated project.
- Include the source URL and author for attribution and later review.

## 13. Local bridge risk record

The backend uses the browser-provided extension origin as its web-origin boundary. This blocks ordinary websites but is not intended to isolate Weaver from other local processes running as the same user.

Compensating boundaries:

- Bind the Weaver backend only to `127.0.0.1`.
- Require the exact installed Weaver extension origin during the WebSocket upgrade.
- Launch app-server over stdio so it is not directly reachable over TCP.
- Reject configured endpoints that resolve to non-loopback interfaces by default.
- Keep privileged RPC construction exclusively in the extension service worker.
- Request host access only for the exact loopback endpoint.
- Do not expose the relay to X page JavaScript or accept arbitrary browser origins.
- Document that loopback plus origin validation is not a boundary against same-user local processes.
- Revisit capability-token pairing before broad distribution if the backend grows beyond a developer-run companion.

## 14. Design implementation

Source of truth: [Weaver in Paper](https://app.paper.design/file/01KZ7HXJF5HPVBTHVV8P208AZW/1-0).

### Brand tokens

```css
--weaver-canvas: #000000;
--weaver-surface: #151515;
--weaver-surface-raised: #1c1c1c;
--weaver-text: #f2f2f2;
--weaver-muted: #8b98a5;
--weaver-divider: #2f3336;
--weaver-accent: #f4d35e;
--weaver-success: #66d28b;
```

### Tweet action

- Woven-loop icon plus `Weave` label.
- Straw-yellow foreground and low-opacity accent surface.
- Native action-row height.
- Insert immediately before X's share action.
- Include keyboard focus and hover treatment while keeping one permanent visual state.

### Setup and recovery

- 420px-wide black setup surface.
- Weaver mark and `Nothing to manage. Just weave.` headline.
- Project folder and local Codex connection settings only.
- Copyable offline recovery command.
- No recent-build or conversation UI.

## 15. Testing strategy

### Unit tests

- Post URL and ID extraction.
- Text, quote, media, and outbound-link normalization.
- Slug generation and path rejection cases.
- RPC request/response correlation.
- Build-state reducer.
- Prompt-envelope escaping and untrusted-content separation.
- Duplicate-click behavior.

### DOM fixture tests

Maintain representative fixtures for:

- Home timeline post.
- Post detail page.
- Quoted post.
- Post with images.
- Post with video.
- Long post.
- Repost and reply context.
- Virtualized timeline removal and reinsertion.

Assert one injected action per post and no layout regression.

### App-server integration tests

- Backend origin rejection and loopback-only binding.
- Backend launch and supervision of the stdio app-server.
- Request-ID remapping and cached initialization across extension reconnects.
- Initialization handshake.
- Offline and reconnect behavior.
- Project directory creation and collision handling.
- Thread creation with exact `cwd`.
- Initial turn submission.
- Turn completion and error notifications.
- Workspace write-boundary enforcement.
- Protocol behavior against the pinned Codex version.

### End-to-end tests

- Load unpacked extension in Chrome.
- Open an X fixture or controlled test post.
- Click Weave once.
- Verify one directory and one thread.
- Verify generated files exist.
- Verify Codex deep link opens the correct thread.
- Continue with a follow-up prompt in Desktop.
- Repeat after Chrome and Desktop restart.

## 16. Delivery phases

### Phase 0: compatibility spike

Build the smallest possible local backend and extension service worker pair that proves:

- Chrome-to-backend WebSocket connectivity with exact origin validation.
- Backend-to-app-server stdio connectivity.
- Initialize handshake.
- Fixed command execution in a scratch directory.
- Thread and turn creation.
- Desktop deep-link handoff.
- Persistence across app restart.

Do not invest in X DOM integration until these gates pass.

### Phase 1: X injection prototype

- Add the content script and MutationObserver.
- Inject a plain action into controlled post fixtures.
- Extract normalized post data.
- Send it to a mocked service worker.
- Add idempotency and virtualized-timeline tests.

### Phase 2: local build pipeline

- Implement validated project naming.
- Create the extension-specific root and child project directory.
- Implement the fixed Weaver build prompt.
- Submit through app-server.
- Persist build metadata.

### Phase 3: Desktop handoff

- Name threads.
- Add `codex://threads/<thread-id>` launching.
- Decide accepted-versus-completed handoff timing based on the spike.
- Add completion tracking and Desktop deep-link handoff.

### Phase 4: production UI

- Implement the approved Paper tweet action.
- Implement the setup/recovery surface and permanent per-tweet action.
- Add accessibility, keyboard, reduced-motion, and contrast verification.
- Add concise recovery guidance.

### Phase 5: hardening and release

- Pin and document Codex compatibility.
- Test Windows, macOS, and Linux path behavior as supported.
- Add X DOM telemetry only if it can be privacy-preserving and optional.
- Complete Chrome Web Store privacy disclosures.
- Run threat modeling for unauthenticated localhost access and prompt injection.
- Package a closed beta before public listing.

## 17. Release blockers

- The developer-run backend still needs an installer and lifecycle strategy for broad distribution.
- The current origin boundary does not authenticate same-user local processes.
- Custom-created threads cannot be opened reliably in Codex Desktop.
- Active or completed builds disappear from Desktop history.
- App-server approval requests deadlock unattended builds.
- Project creation cannot be made cross-platform without exposing arbitrary command execution.
- X injection causes duplicate actions or breaks common timeline layouts.

## 18. Future possibilities

These are intentionally deferred:

- `Weave another version` using a new directory and forked thread.
- Support for other idea sources such as Reddit, Hacker News, GitHub issues, or product screenshots.
- Optional project templates.
- Optional cloud execution for users without a local machine.
- Automatic preview detection and links.
- Optional capability-token authentication if product requirements change.
- Sharing Weaver build recipes or prompt templates.

## 19. Immediate next steps

1. Scaffold the Manifest V3 extension and test harness.
2. Pin a Codex CLI version for the compatibility spike.
3. Start the Weaver backend and let it launch `codex app-server --stdio`.
4. Verify the backend's origin gate and JSON-RPC relay.
5. Create a scratch project, thread, and turn through app-server.
6. Verify `codex://threads/<thread-id>` opens the same project in Desktop.
7. Record the result before proceeding to X DOM work.
