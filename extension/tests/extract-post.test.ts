import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { extractPost } from "../src/content/extract-post";

const fixture = (name: string) => readFileSync(resolve(import.meta.dirname, "fixtures", name), "utf8");

beforeEach(() => { document.body.replaceChildren(); });

describe("X post extraction", () => {
  it("extracts the canonical identity and preserves text", () => {
    document.body.innerHTML = fixture("home-post.html");
    const post = extractPost(document.querySelector("article")!, new Date("2026-08-05T12:00:00Z"));
    expect(post).toMatchObject({
      postId: "195123456789",
      canonicalUrl: "https://x.com/thenanyu/status/195123456789",
      authorDisplayName: "Nan Yu",
      authorHandle: "@thenanyu",
      text: "You should be able to pledge tokens for issues that you open",
    });
  });

  it("extracts one quote level, media, and outbound links", () => {
    document.body.innerHTML = fixture("quoted-media-post.html");
    const post = extractPost(document.querySelector("article")!);
    expect(post?.quotedPost).toEqual({
      authorHandle: "@joelbuilds",
      canonicalUrl: "https://x.com/joelbuilds/status/195400000001",
      text: "Ambient rooms make focus feel social.",
    });
    expect(post?.mediaUrls).toEqual(["https://pbs.twimg.com/media/example.jpg"]);
    expect(post?.outboundUrls).toEqual(["https://example.com/product", "https://t.co/abc123"]);
  });
});
