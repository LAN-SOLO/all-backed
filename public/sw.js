// all backed — minimal MV3 background script (service worker on Chromium,
// event page on Firefox). The whole app lives in a full tab page (CCC-style
// task window); the toolbar button just opens (or focuses) it.
const api = globalThis.browser ?? globalThis.chrome;

async function findAppTab(url) {
  // Chrome 116+: runtime.getContexts lists our own tab pages with tab and
  // window ids — no "tabs" permission needed, no URL guessing
  if (typeof api.runtime.getContexts === 'function') {
    try {
      const contexts = await api.runtime.getContexts({ contextTypes: ['TAB'] });
      const own = contexts.find(
        (ctx) => typeof ctx.documentUrl === 'string' && ctx.documentUrl.startsWith(url) && ctx.tabId >= 0
      );
      if (own) return { id: own.tabId, windowId: own.windowId >= 0 ? own.windowId : undefined };
    } catch {
      // fall through to tabs.query
    }
  }
  try {
    const tabs = await api.tabs.query({ url });
    // Without the "tabs" permission a browser may ignore the url filter or
    // hide tab URLs. Only trust tabs whose URL is visibly our own page, so we
    // never focus some unrelated tab.
    return tabs.find((tab) => typeof tab.url === 'string' && tab.url.startsWith(url)) ?? null;
  } catch {
    // e.g. a browser that rejects extension URLs as query patterns
    return null;
  }
}

async function openApp() {
  const url = api.runtime.getURL('index.html');
  const tab = await findAppTab(url);
  if (tab && tab.id !== undefined) {
    try {
      await api.tabs.update(tab.id, { active: true });
      if (tab.windowId !== undefined) {
        await api.windows.update(tab.windowId, { focused: true });
      }
      return;
    } catch {
      // tab vanished between query and update — open a fresh one
    }
  }
  await api.tabs.create({ url });
}

api.action.onClicked.addListener(() => {
  void openApp();
});
