import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it, vi } from "vitest";
import type { RuntimeRequest, RuntimeResponse } from "../src/shared/messages";

it("keeps one Weave action and submits the latest context when X updates or recycles an article", async () => {
  vi.resetModules();
  document.body.innerHTML = readFileSync(resolve(import.meta.dirname, "fixtures/home-post.html"), "utf8");
  const sendMessage = vi.fn(async (_message: RuntimeRequest): Promise<RuntimeResponse> => ({ ok: true }));
  const alert = vi.spyOn(window, "alert").mockImplementation(() => undefined);
  Object.assign(globalThis, {
    chrome: { runtime: { sendMessage } },
  });

  const { timelineObserver } = await import("../src/content/inject-weave-action");
  await new Promise((resolveMutation) => setTimeout(resolveMutation, 0));

  const article = document.querySelector<HTMLElement>('article[data-testid="tweet"]')!;
  const button = article.querySelector<HTMLButtonElement>(".weaver-action")!;
  expect(button.textContent).toBe("");
  expect(button.getAttribute("aria-label")).toBe("Weave");
  expect(button.dataset.tooltip).toBe("Weave");
  expect(button.disabled).toBe(false);
  expect(button.closest<HTMLElement>("[data-weaver-action-slot]")?.dataset.postId).toBe("195123456789");

  article.querySelector('[data-testid="tweetText"]')!.textContent = "Updated context for the same post";
  await new Promise((resolveMutation) => setTimeout(resolveMutation, 0));
  expect(article.querySelector(".weaver-action")).toBe(button);
  button.click();
  await new Promise((resolveClick) => setTimeout(resolveClick, 0));
  expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
    type: "WEAVE_POST",
    post: expect.objectContaining({ postId: "195123456789", text: "Updated context for the same post" }),
  }));

  sendMessage.mockResolvedValueOnce({
    ok: false,
    error: "Weaver backend is offline. Start it locally.",
  });
  button.click();
  await new Promise((resolveClick) => setTimeout(resolveClick, 0));
  expect(alert).toHaveBeenCalledWith(expect.stringContaining("Weaver backend is offline"));
  expect(button.getAttribute("aria-label")).toBe("Weave");
  expect(button.disabled).toBe(false);

  article.querySelector<HTMLAnchorElement>('a[href*="/status/"]')!.href = "https://x.com/thenanyu/status/999";
  await new Promise((resolveMutation) => setTimeout(resolveMutation, 0));

  const recycledButton = article.querySelector<HTMLButtonElement>(".weaver-action")!;
  expect(recycledButton).not.toBe(button);
  expect(recycledButton.getAttribute("aria-label")).toBe("Weave");
  expect(recycledButton.disabled).toBe(false);
  expect(recycledButton.closest<HTMLElement>("[data-weaver-action-slot]")?.dataset.postId).toBe("999");

  article.querySelector('[data-testid="tweetText"]')!.firstChild!.textContent = "A different recycled post";
  await new Promise((resolveMutation) => setTimeout(resolveMutation, 0));
  recycledButton.click();
  await new Promise((resolveClick) => setTimeout(resolveClick, 0));
  expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
    type: "WEAVE_POST",
    post: expect.objectContaining({ postId: "999", text: "A different recycled post" }),
  }));
  timelineObserver.disconnect();
});

it("inserts before X's final action when the share test id is absent", async () => {
  vi.resetModules();
  document.body.innerHTML = readFileSync(resolve(import.meta.dirname, "fixtures/home-post.html"), "utf8");
  Object.assign(globalThis, {
    chrome: { runtime: { sendMessage: vi.fn(async (): Promise<RuntimeResponse> => ({ ok: true })) } },
  });

  const article = document.querySelector<HTMLElement>('article[data-testid="tweet"]')!;
  const actionRow = article.querySelector<HTMLElement>('[role="group"]')!;
  const share = actionRow.querySelector<HTMLElement>('[data-testid="share"]')!;
  share.removeAttribute("data-testid");
  share.setAttribute("aria-label", "Share post");

  const { timelineObserver } = await import("../src/content/inject-weave-action");
  await new Promise((resolveMutation) => setTimeout(resolveMutation, 0));

  const slot = actionRow.querySelector<HTMLElement>("[data-weaver-action-slot]")!;
  expect(slot).not.toBeNull();
  expect(slot.nextElementSibling).toContain(share);
  timelineObserver.disconnect();
});

it("turns a synchronously invalidated extension context into refresh guidance", async () => {
  vi.resetModules();
  document.body.innerHTML = readFileSync(resolve(import.meta.dirname, "fixtures/home-post.html"), "utf8");
  const alert = vi.spyOn(window, "alert").mockImplementation(() => undefined);
  Object.assign(globalThis, {
    chrome: {
      runtime: {
        sendMessage: vi.fn(() => {
          throw new Error("Extension context invalidated.");
        }),
      },
    },
  });

  const { timelineObserver } = await import("../src/content/inject-weave-action");
  await new Promise((resolveMutation) => setTimeout(resolveMutation, 0));
  document.querySelector<HTMLButtonElement>(".weaver-action")!.click();

  expect(alert).toHaveBeenCalledWith(expect.stringContaining("Refresh this X tab"));
  timelineObserver.disconnect();
});
