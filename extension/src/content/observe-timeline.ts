export function observeTimeline(onArticle: (article: HTMLElement) => void, root: ParentNode = document): MutationObserver {
  const scan = (scope: ParentNode) => {
    if (scope instanceof HTMLElement) {
      const containingArticle = scope.matches('article[data-testid="tweet"]')
        ? scope
        : scope.closest<HTMLElement>('article[data-testid="tweet"]');
      if (containingArticle) onArticle(containingArticle);
    }
    scope.querySelectorAll<HTMLElement>('article[data-testid="tweet"]').forEach(onArticle);
  };

  scan(root);
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      const target = mutation.target instanceof HTMLElement
        ? mutation.target
        : mutation.target.parentElement;
      if (target) scan(target);
      for (const node of mutation.addedNodes) {
        if (node instanceof HTMLElement) scan(node);
      }
    }
  });
  observer.observe(root === document ? document.documentElement : root, {
    attributes: true,
    attributeFilter: ["href"],
    characterData: true,
    childList: true,
    subtree: true,
  });
  return observer;
}
