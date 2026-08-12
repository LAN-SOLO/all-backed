// all backed — minimal MV3 background script (service worker on Chromium,
// event page on Firefox). The whole app lives in a full tab page (CCC-style
// task window); the toolbar button just opens (or focuses) it.
const api = globalThis.browser ?? globalThis.chrome;

api.action.onClicked.addListener(async () => {
  const url = api.runtime.getURL('index.html');
  const tabs = await api.tabs.query({ url });
  if (tabs.length > 0 && tabs[0].id !== undefined) {
    await api.tabs.update(tabs[0].id, { active: true });
    if (tabs[0].windowId !== undefined) {
      await api.windows.update(tabs[0].windowId, { focused: true });
    }
  } else {
    await api.tabs.create({ url });
  }
});
