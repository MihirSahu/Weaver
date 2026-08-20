import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { observeTimeline } from "../src/content/observe-timeline";

it("discovers virtualized timeline reinsertion without duplicating one mounted article", async () => {
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  const seen = new WeakSet<HTMLElement>();
  const onArticle = vi.fn((article: HTMLElement) => {
    if (seen.has(article)) return;
    seen.add(article);
  });
  const observer = observeTimeline(onArticle, root);
  root.innerHTML = readFileSync(resolve(import.meta.dirname, "fixtures/home-post.html"), "utf8");
  await new Promise((resolveMutation) => setTimeout(resolveMutation, 0));
  const first = root.querySelector("article")!;
  first.remove();
  root.append(first);
  await new Promise((resolveMutation) => setTimeout(resolveMutation, 0));
  expect(onArticle).toHaveBeenCalled();
  expect(seen.has(first)).toBe(true);
  observer.disconnect();
});

it("rescans the containing tweet when X replaces descendants inside an existing article", async () => {
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  root.innerHTML = readFileSync(resolve(import.meta.dirname, "fixtures/home-post.html"), "utf8");
  const article = root.querySelector<HTMLElement>("article")!;
  const onArticle = vi.fn();
  const observer = observeTimeline(onArticle, root);
  onArticle.mockClear();

  article.querySelector('[data-testid="tweetText"]')!.append(document.createElement("span"));
  await new Promise((resolveMutation) => setTimeout(resolveMutation, 0));

  expect(onArticle).toHaveBeenCalledWith(article);
  observer.disconnect();
});

it("rescans a recycled tweet when X changes an existing status link", async () => {
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  root.innerHTML = readFileSync(resolve(import.meta.dirname, "fixtures/home-post.html"), "utf8");
  const article = root.querySelector<HTMLElement>("article")!;
  const statusLink = article.querySelector<HTMLAnchorElement>('a[href*="/status/"]')!;
  const onArticle = vi.fn();
  const observer = observeTimeline(onArticle, root);
  onArticle.mockClear();

  statusLink.href = "https://x.com/thenanyu/status/999";
  await new Promise((resolveMutation) => setTimeout(resolveMutation, 0));

  expect(onArticle).toHaveBeenCalledWith(article);
  observer.disconnect();
});

it("rescans a recycled tweet when X edits an existing text node", async () => {
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  root.innerHTML = readFileSync(resolve(import.meta.dirname, "fixtures/home-post.html"), "utf8");
  const article = root.querySelector<HTMLElement>("article")!;
  const textNode = article.querySelector('[data-testid="tweetText"]')!.firstChild!;
  const onArticle = vi.fn();
  const observer = observeTimeline(onArticle, root);
  onArticle.mockClear();

  textNode.textContent = "Recycled tweet text";
  await new Promise((resolveMutation) => setTimeout(resolveMutation, 0));

  expect(onArticle).toHaveBeenCalledWith(article);
  observer.disconnect();
});
