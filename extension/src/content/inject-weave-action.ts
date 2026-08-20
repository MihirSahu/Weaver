import type { RuntimeRequest, RuntimeResponse } from "../shared/messages";
import { extractPost } from "./extract-post";
import { observeTimeline } from "./observe-timeline";

const STYLE_ID = "weaver-action-styles";

function installStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .weaver-action-slot{display:flex;align-items:center;justify-content:center;flex-shrink:0}
    .weaver-action{height:47px;display:flex;align-items:center;justify-content:center;gap:6px;padding:0 10px;border:0;border-radius:999px;background:#F4D35E24;color:#F4D35E;font:700 13px/16px Arial,system-ui,sans-serif;letter-spacing:-.01em;cursor:pointer;transition:background-color .16s ease,color .16s ease,opacity .16s ease}
    .weaver-action:hover{background:#F4D35E36}.weaver-action:focus-visible{outline:2px solid #F4D35E;outline-offset:2px}
    .weaver-action svg{width:18px;height:18px;flex-shrink:0;overflow:visible}
    @media (prefers-reduced-motion:reduce){.weaver-action{transition:none}}
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

function showWeaveError(error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  window.alert(
    `Weaver couldn't start this build.\n\n${detail}\n\nOpen Weaver from the Chrome toolbar for setup and recovery.`,
  );
}

export function injectWeaveAction(article: HTMLElement): HTMLButtonElement | null {
  const post = extractPost(article);
  if (!post) return null;
  const oldSlots = [...article.querySelectorAll<HTMLElement>("[data-weaver-action-slot]")];
  const matching = oldSlots.find((slot) => slot.dataset.postId === post.postId);
  if (matching) return matching.querySelector("button");
  oldSlots.forEach((slot) => slot.remove());

  const share = article.querySelector<HTMLElement>('[data-testid="share"]');
  const actionRow = share?.closest('[role="group"]');
  if (!share || !actionRow) return null;
  const shareSlot = directChildContaining(actionRow, share);
  if (!shareSlot) return null;

  const slot = document.createElement("div");
  slot.className = "weaver-action-slot";
  slot.dataset.weaverActionSlot = "";
  slot.dataset.postId = post.postId;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "weaver-action";
  button.title = "Weave";
  button.setAttribute("aria-label", "Weave");
  button.append(markSvg());
  const label = document.createElement("span");
  label.className = "weaver-action-label";
  label.textContent = "Weave";
  button.append(label);
  slot.append(button);
  actionRow.insertBefore(slot, shareSlot);

  button.addEventListener("click", () => {
    const currentPost = extractPost(article);
    if (!currentPost || currentPost.postId !== slot.dataset.postId) return;
    void chrome.runtime
      .sendMessage<RuntimeRequest, RuntimeResponse>({ type: "WEAVE_POST", post: currentPost })
      .then((response) => {
        if (!response.ok) showWeaveError(response.error);
      })
      .catch(showWeaveError);
  });
  return button;
}

installStyles();
export const timelineObserver = observeTimeline(injectWeaveAction);
