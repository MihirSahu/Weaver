export function threadDeepLink(threadId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(threadId)) throw new Error("Invalid Codex thread ID.");
  return `codex://threads/${encodeURIComponent(threadId)}`;
}

export async function openThread(threadId: string): Promise<void> {
  await chrome.tabs.create({ url: threadDeepLink(threadId), active: true });
}
