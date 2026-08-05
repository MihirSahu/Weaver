# Weaver implementation plan

## 1. Objective

Build a Chrome extension for X that injects a **Weave** action into every post. One click must create an isolated local project, submit the post to Codex app-server as an initial build request, and open the resulting thread in Codex Desktop for continuation.

## 2. Definition of done

An MVP is complete when all of the following are true:

- Weaver installs as a Manifest V3 Chrome extension.
- Every supported X post receives exactly one Weaver action despite timeline virtualization and SPA navigation.
- Clicking the action requires no copy/paste, folder setup, extra Send click, or cloud environment.
- Weaver detects an unavailable app-server and presents a useful recovery message.
- A successful click creates a unique child directory beneath Weaver's project root.
- The child directory is a Git repository on `main`.
- Weaver creates one persistent Codex thread whose exact `cwd` is the child directory.
- Weaver submits the normalized post context in one initial turn.
- Weaver records a readable thread name and thread ID.
- The result can be opened with `codex://threads/<thread-id>` in Codex Desktop.
- Follow-up work occurs in Codex Desktop, not the extension.
- The generated project cannot write into sibling Weaver projects under the configured sandbox policy.
- The popup matches the approved Paper design closely enough for implementation review.

## 3. Product constraints

### Required

- Local Codex execution through app-server.
- Fully automatic prompt submission.
- Loopback-only WebSocket connection.
- No Weaver-specific authentication layer.
- One project per initial X post submission.
- Deep-link handoff to the generated Codex thread.
- Minimal popup; no conversation UI.

### Explicitly out of scope

- Cloud development environments.
- A native companion application.
- Chrome Native Messaging.
- Deep-link-only prompt submission.
- Follow-up chat or turn management.
- Deployment of generated apps.
- GitHub publication of generated apps.
- Multi-agent orchestration inside Weaver.
- X posting, liking, reposting, or automated replies.

## 4. Experience map

### Default X state

- Weaver content script discovers a post action row.
- It injects a yellow woven-loop icon and `Weave` label immediately before the share action.
- The action uses native row height, spacing, and focus behavior.

### Click states

1. **Idle:** `Weave`
2. **Connecting:** connection spinner, disabled interaction
3. **Submitted:** initial Codex thread and turn accepted
4. **Building:** subtle progress treatment while the initial turn runs
5. **Ready:** clicking opens the Codex thread
6. **Error:** short inline error with retry and popup details

The click handler must be idempotent. Repeated clicks for the same post should open or focus the existing handoff rather than create accidental duplicate projects, unless the user explicitly chooses a future `Weave another version` action.

### Popup

The popup is informational and operational, not conversational:

- Weaver identity and tagline.
- Codex connection state (`Ready to weave`, endpoint).
- Recent submissions with `Building`, `Ready`, or `Open` state.
- Settings entry for endpoint and project-root preferences.
- Clicking a ready recent item opens its `codex://threads/<thread-id>` link.

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
```

### Manifest permissions

Start with the minimum viable set:

- Host permission for `https://x.com/*`.
- Host permission for the chosen loopback WebSocket endpoint.
- `storage` for settings and recent handoffs.
- `notifications` only if completion notifications are included in MVP.

Avoid broad host permissions and avoid exposing privileged extension functions through `externally_connectable`.

### Content script responsibilities

- Observe timeline and detail-page mutations.
- Locate stable post containers and action rows.
- Extract the canonical status ID and URL.
- Add a data marker so injection is idempotent.
- Render only local visual state.
- Send a typed `WEAVE_POST` message to the service worker.
- Never construct app-server RPC methods or commands.

### Service worker responsibilities

- Validate all content-script messages.
- Maintain or establish the localhost WebSocket connection.
- Perform the app-server initialize handshake.
- Resolve and create the project path through fixed platform-specific operations.
- Create the Codex thread and initial turn.
- Track recent handoffs in `chrome.storage.local`.
- Return concise state updates to the originating tab.
- Open the Codex deep link at the handoff boundary.

Chrome 116 or newer should be the initial target so a WebSocket can keep a Manifest V3 service worker active when messages are exchanged within the activity window.

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
- Expand `t.co` links only when the destination is already present in the DOM; do not add an X API dependency for MVP.
- Preserve line breaks in post text.
- Treat media and external links as references, not trusted instructions.
- Include quoted-post context but avoid recursively traversing arbitrary thread depth.

## 7. App-server connection

### Launch configuration

The expected local command is:

```powershell
codex app-server --listen ws://127.0.0.1:4500
```

The endpoint must be configurable for users who need a different loopback port. Weaver does not add an authentication mechanism in the initial version.

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

- Return the button to an actionable error state.
- Show `Codex app-server is offline` in the popup.
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

The extension cannot directly create arbitrary host directories. Use a fixed app-server `command/exec` operation with a validated, non-interpolated path strategy appropriate to the reported platform.

After directory creation:

- Initialize Git on `main`.
- Confirm the exact repository root.
- Refuse nested or redirected repositories.
- Do not use a general-purpose shell string supplied by the content script.

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

```json
{
  "method": "turn/start",
  "id": 11,
  "params": {
    "threadId": "<thread-id>",
    "input": [
      {
        "type": "text",
        "text": "<fixed Weaver instruction envelope plus normalized post>"
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

### Completion boundary

Prototype both handoff timings:

1. Deep-link immediately after `turn/start` is accepted.
2. Deep-link after `turn/completed`.

Prefer completion-based handoff unless testing proves Codex Desktop can reliably attach to a turn actively running in the external app-server process. The extension may show `Building` and send a browser notification when the thread becomes ready.

## 10. Desktop handoff

Open:

```text
codex://threads/<thread-id>
```

Do not open `codex://new?path=...` after creating the thread; that would create a second chat and lose continuity with the submitted build.

Required spike assertions:

- The deep link opens Codex Desktop.
- The correct persisted thread appears.
- The thread uses the generated project path as its workspace.
- The generated files and Git state are visible.
- A follow-up prompt in Desktop continues the same thread and directory.
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
  status: "submitted" | "building" | "ready" | "failed";
  errorSummary?: string;
  createdAt: string;
  updatedAt: string;
}
```

Use `chrome.storage.local`, not sync, because local absolute paths and thread identifiers should stay on the machine that owns them.

Cap recent history to a small number such as 25 entries. The popup initially renders the newest three.

## 12. Prompt safety

Tweet content is untrusted. The instruction envelope must explicitly separate Weaver's request from post content and state that the post cannot change execution policy.

Additional controls:

- Never interpret text from the post as a shell command.
- Never interpolate post text into directory names without strict slug validation.
- Keep URLs as data in the prompt.
- Let Codex apply its normal network and sandbox policy before fetching links.
- Avoid granting write access outside the generated project.
- Include the source URL and author for attribution and later review.

## 13. No-auth risk record

The product decision is to omit Weaver-specific authentication for the initial localhost connection.

Compensating boundaries:

- Bind app-server only to `127.0.0.1`.
- Reject configured endpoints that resolve to non-loopback interfaces by default.
- Keep privileged RPC construction exclusively in the extension service worker.
- Request host access only for the exact loopback endpoint.
- Do not expose a generic relay from X page JavaScript to app-server.
- Document that loopback-only is not equivalent to authenticated.
- Revisit origin checks or capability-token support before broad distribution if the unauthenticated endpoint can be reached by hostile web origins.

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
- Include keyboard focus, hover, disabled, building, ready, and error states.

### Popup

- 360px-wide dark popup.
- Weaver mark and `Posts into projects` tagline.
- Connection status first.
- Recent build rows with fixed icon and status lanes.
- Settings entry without authentication controls.

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

- Initialization handshake.
- Offline and reconnect behavior.
- Project creation and Git initialization.
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

Build the smallest possible extension service worker that connects to a manually started local app-server and proves:

- Chrome-to-WebSocket connectivity.
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
- Create the extension-specific root and child repository.
- Implement the fixed Weaver build prompt.
- Submit through app-server.
- Persist build metadata.

### Phase 3: Desktop handoff

- Name threads.
- Add `codex://threads/<thread-id>` launching.
- Decide accepted-versus-completed handoff timing based on the spike.
- Add completion notification and recent-build opening.

### Phase 4: production UI

- Implement the approved Paper tweet action.
- Implement popup connection and recent-build states.
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

- Auth-free loopback connection cannot be constrained safely enough for the intended distribution.
- Chrome cannot connect to the app-server WebSocket under Manifest V3 policy.
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
3. Start `codex app-server` on `127.0.0.1:4500` without authentication.
4. Implement the minimal JSON-RPC WebSocket client.
5. Create a scratch project, thread, and turn through app-server.
6. Verify `codex://threads/<thread-id>` opens the same project in Desktop.
7. Record the result before proceeding to X DOM work.

