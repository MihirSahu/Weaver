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
  expect(button.textContent).toContain("Weave");
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
    error: "Codex app-server is offline. Start it locally.",
  });
  button.click();
  await new Promise((resolveClick) => setTimeout(resolveClick, 0));
  expect(alert).toHaveBeenCalledWith(expect.stringContaining("Codex app-server is offline"));
  expect(button.textContent).toContain("Weave");
  expect(button.disabled).toBe(false);

  article.querySelector<HTMLAnchorElement>('a[href*="/status/"]')!.href = "https://x.com/thenanyu/status/999";
  await new Promise((resolveMutation) => setTimeout(resolveMutation, 0));

  const recycledButton = article.querySelector<HTMLButtonElement>(".weaver-action")!;
  expect(recycledButton).not.toBe(button);
  expect(recycledButton.textContent).toContain("Weave");
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
