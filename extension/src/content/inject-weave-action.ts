import type { RuntimeRequest, RuntimeResponse } from "../shared/messages";
import { extractPost } from "./extract-post";
import { observeTimeline } from "./observe-timeline";

const STYLE_ID = "weaver-action-styles";

function installStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .weaver-action-slot{width:34px;height:34px;display:flex;align-items:center;justify-content:center;flex-shrink:0;position:relative}
    .weaver-action{width:34px;height:34px;display:flex;align-items:center;justify-content:center;padding:0;border:0;border-radius:999px;background:transparent;color:#71767B;cursor:pointer;position:relative;transition:background-color .16s ease,color .16s ease}
    .weaver-action:hover,.weaver-action:focus-visible{background:#F4D35E24;color:#F4D35E}
    .weaver-action:focus-visible{outline:2px solid #F4D35E;outline-offset:2px}
    .weaver-action svg{width:20px;height:20px;flex-shrink:0;overflow:visible}
    .weaver-action::after{content:attr(data-tooltip);position:absolute;left:50%;bottom:calc(100% + 7px);z-index:2;transform:translateX(-50%) translateY(2px);padding:6px 8px;border-radius:4px;background:#536471;color:#fff;font:700 11px/14px Arial,system-ui,sans-serif;white-space:nowrap;opacity:0;pointer-events:none;transition:opacity .12s ease,transform .12s ease}
    .weaver-action:hover::after,.weaver-action:focus-visible::after{opacity:1;transform:translateX(-50%) translateY(0)}
    @media (hover:hover) and (pointer:fine){
      .weaver-action-slot{opacity:0;pointer-events:none;transform:translateY(2px);transition:opacity .16s ease,transform .16s ease}
      article[data-testid="tweet"]:hover .weaver-action-slot,article[data-testid="tweet"]:focus-within .weaver-action-slot{opacity:1;pointer-events:auto;transform:translateY(0)}
    }
    @media (prefers-reduced-motion:reduce){.weaver-action,.weaver-action-slot,.weaver-action::after{transition:none}}
  `;
  document.documentElement.append(style);
}

function markSvg(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("aria-hidden", "true");
  for (const d of [
    "M3 7.2C5.8 3.8 12.4 3.7 16.8 7.1",
    "M2.5 10.2C6.1 6.6 13.2 6.6 17.4 10.1",
    "M3.7 13.1C7.2 10.4 12.6 10.4 16.2 13.1",
    "M6.3 15.4C8.6 14.3 11.5 14.3 13.8 15.4",
  ]) {
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.8");
    path.setAttribute("stroke-linecap", "round");
    svg.append(path);
  }
  return svg;
}

function directChildContaining(parent: Element, child: Element): Element | null {
  let current: Element | null = child;
  while (current?.parentElement && current.parentElement !== parent) current = current.parentElement;
  return current?.parentElement === parent ? current : null;
}

function findActionRow(article: HTMLElement): Element | null {
  const knownAction = article.querySelector<HTMLElement>(
    '[data-testid="share"], [data-testid="reply"], [data-testid="retweet"], [data-testid="unretweet"], [data-testid="like"], [data-testid="unlike"]',
  );
  return knownAction?.closest('[role="group"]') ?? null;
}

function findShareSlot(actionRow: Element): Element | null {
  const share = actionRow.querySelector<HTMLElement>(
    '[data-testid="share"], [aria-label="Share post"]',
  );
  if (share) return directChildContaining(actionRow, share);

  // X no longer consistently exposes data-testid="share". The share action is
  // still the final direct slot in the post action group, after Bookmark.
  return actionRow.lastElementChild;
}

function showWeaveError(error: unknown): void {
  const rawDetail = error instanceof Error ? error.message : String(error);
  const detail = /extension context invalidated/i.test(rawDetail)
    ? "Weaver was reloaded after this X tab opened. Refresh this X tab and choose Weave again."
    : rawDetail;
  window.alert(
    `Weaver couldn't start this build.\n\n${detail}\n\nOpen Weaver from the Chrome toolbar for setup and recovery.`,
  );
}

function requestWeave(post: RuntimeRequest & { type: "WEAVE_POST" }): void {
  let response: Promise<RuntimeResponse>;
  try {
    // Chrome throws synchronously here when an unpacked extension was reloaded
    // after this content script entered the page. A Promise catch alone cannot
    // handle that invalidated-context failure.
    response = chrome.runtime.sendMessage<RuntimeRequest, RuntimeResponse>(post);
  } catch (error) {
    showWeaveError(error);
    return;
  }
  void response
    .then((result) => {
      if (!result.ok) showWeaveError(result.error);
    })
    .catch(showWeaveError);
}

export function injectWeaveAction(article: HTMLElement): HTMLButtonElement | null {
  const post = extractPost(article);
  if (!post) return null;
  const oldSlots = [...article.querySelectorAll<HTMLElement>("[data-weaver-action-slot]")];
  const matching = oldSlots.find((slot) => slot.dataset.postId === post.postId);
  if (matching) return matching.querySelector("button");
  oldSlots.forEach((slot) => slot.remove());

  const actionRow = findActionRow(article);
  if (!actionRow) return null;
  const shareSlot = findShareSlot(actionRow);
  if (!shareSlot) return null;

  const slot = document.createElement("div");
  slot.className = "weaver-action-slot";
  slot.dataset.weaverActionSlot = "";
  slot.dataset.postId = post.postId;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "weaver-action";
  button.setAttribute("aria-label", "Weave");
  button.dataset.tooltip = "Weave";
  button.append(markSvg());
  slot.append(button);
  actionRow.insertBefore(slot, shareSlot);

  button.addEventListener("click", () => {
    const currentPost = extractPost(article);
    if (!currentPost || currentPost.postId !== slot.dataset.postId) return;
    requestWeave({ type: "WEAVE_POST", post: currentPost });
  });
  return button;
}

installStyles();
export const timelineObserver = observeTimeline(injectWeaveAction);
