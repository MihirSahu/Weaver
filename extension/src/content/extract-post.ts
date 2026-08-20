import type { PostContext, QuotedPostContext } from "../shared/models";
import { normalizeStatusUrl } from "../shared/validation";

const textOf = (element: Element | null): string => {
  if (!element) return "";
  return ((element as HTMLElement).innerText ?? element.textContent ?? "").trim();
};

const unique = (values: string[]): string[] => [...new Set(values)];

function normalizedHttpsUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function statusLinks(article: Element): Array<{ anchor: HTMLAnchorElement; value: NonNullable<ReturnType<typeof normalizeStatusUrl>> }> {
  return [...article.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]')]
    .map((anchor) => ({ anchor, value: normalizeStatusUrl(anchor.getAttribute("href") ?? anchor.href) }))
    .filter((item): item is { anchor: HTMLAnchorElement; value: NonNullable<ReturnType<typeof normalizeStatusUrl>> } => item.value !== null);
}

function primaryStatus(article: Element) {
  const links = statusLinks(article);
  const timeLink = links.find(({ anchor }) => anchor.querySelector("time"));
  return timeLink?.value ?? links[0]?.value ?? null;
}

function quotedContext(article: Element, primaryId: string, tweetTexts: Element[]): QuotedPostContext | undefined {
  if (tweetTexts.length < 2) return undefined;
  const quoteText = tweetTexts[1];
  if (!quoteText) return undefined;
  const quoteContainer = quoteText.closest('[role="link"]') ?? quoteText.parentElement;
  const quoteStatus = quoteContainer
    ? statusLinks(quoteContainer).map((item) => item.value).find((value) => value.postId !== primaryId)
    : undefined;
  return {
    ...(quoteStatus?.canonicalUrl ? { canonicalUrl: quoteStatus.canonicalUrl } : {}),
    ...(quoteStatus?.authorHandle ? { authorHandle: quoteStatus.authorHandle } : {}),
    text: textOf(quoteText),
  };
}

export function extractPost(article: Element, capturedAt = new Date()): PostContext | null {
  const status = primaryStatus(article);
  if (!status) return null;

  const tweetTexts = [...article.querySelectorAll('[data-testid="tweetText"]')];
  const userName = article.querySelector('[data-testid="User-Name"]');
  const displayCandidates = userName ? [...userName.querySelectorAll("span")].map(textOf).filter(Boolean) : [];
  const displayName = displayCandidates.find((text) => !text.startsWith("@") && text !== "·") ?? "";
  const visibleHandle = displayCandidates.find((text) => /^@[A-Za-z0-9_]{1,15}$/.test(text));

  const mediaUrls = unique([
    ...[...article.querySelectorAll<HTMLImageElement>('[data-testid="tweetPhoto"] img[src]')].map((image) => image.src),
    ...[...article.querySelectorAll<HTMLVideoElement>("video[poster]")].map((video) => video.poster),
  ].filter((url) => /^https:\/\//.test(url)));

  const outboundUrls = unique([...article.querySelectorAll<HTMLAnchorElement>("a[href]")].flatMap((anchor) => {
    try {
      const href = new URL(anchor.href, location.href);
      if (href.hostname === "x.com" || href.hostname === "www.x.com") return [];
      if (href.hostname === "t.co") {
        const expanded = normalizedHttpsUrl(anchor.dataset.expandedUrl) ?? normalizedHttpsUrl(anchor.title);
        if (expanded) return [expanded];
        return href.protocol === "https:" ? [href.toString()] : [];
      }
      return href.protocol === "https:" ? [href.toString()] : [];
    } catch {
      return [];
    }
  }));

  return {
    postId: status.postId,
    canonicalUrl: status.canonicalUrl,
    authorDisplayName: displayName,
    authorHandle: visibleHandle ?? status.authorHandle,
    text: textOf(tweetTexts[0] ?? null),
    ...(quotedContext(article, status.postId, tweetTexts) ? { quotedPost: quotedContext(article, status.postId, tweetTexts) } : {}),
    mediaUrls,
    outboundUrls,
    capturedAt: capturedAt.toISOString(),
  };
}
