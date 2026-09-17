(function () {
  "use strict";

  const enabled = document.getElementById("enabled");
  const count = document.getElementById("count");
  const synced = document.getElementById("synced");
  const progressWrap = document.getElementById("progress-wrap");
  const progressText = document.getElementById("progress-text");
  const result = document.getElementById("result");
  const sync = document.getElementById("sync");
  const clear = document.getElementById("clear");
  let resetInProgress = false;
  let lastResetSignature = "";

  function channelsOf(value) {
    return value && typeof value === "object" ? value : { ids: [], handles: [], names: [] };
  }

  function channelCount(channels) {
    return Math.max((channels.ids || []).length, (channels.handles || []).length, (channels.names || []).length);
  }

  function render(data) {
    const channels = channelsOf(data.channels);
    let progress = data.syncProgress;
    const now = Date.now();
    const staleProgress = progress && typeof progress.startedAt === "number" && now - progress.startedAt > 180000;
    const stalePending = data.syncPending && !progress &&
      (!data.syncPendingAt || now - data.syncPendingAt > 60000);
    if (staleProgress || stalePending) {
      const signature = String(progress && progress.startedAt || "") + ":" + String(data.syncPendingAt || "");
      if (!resetInProgress && lastResetSignature !== signature) {
        resetInProgress = true;
        lastResetSignature = signature;
        browser.storage.local.set({
          syncProgress: null,
          syncPending: false,
          syncLock: null
        }).catch(() => {}).finally(() => {
          resetInProgress = false;
          refresh();
        });
      }
      progress = null;
      data = { ...data, syncPending: false };
    }
    enabled.checked = data.enabled !== false;
    count.textContent = "Каналов: " + channelCount(channels);
    synced.textContent = "Последняя ручная синхронизация: " + (data.syncedAt ? new Date(data.syncedAt).toLocaleString("ru-RU") : "ещё не было");
    progressWrap.hidden = !progress;
    if (progress) {
      progressText.textContent = "Синхронизация… найдено " + (progress.count || 0);
    }
    sync.disabled = Boolean(progress || data.syncPending);
    if (data.lastSyncResult) {
      result.hidden = false;
      result.textContent = data.lastSyncResult;
    } else {
      result.hidden = true;
    }
  }

  async function refresh() {
    render(await browser.storage.local.get(["enabled", "channels", "syncedAt", "syncProgress", "syncPending", "syncPendingAt", "lastSyncResult"]));
  }

  enabled.addEventListener("change", () => browser.storage.local.set({ enabled: enabled.checked }));
  sync.addEventListener("click", async () => {
    await browser.storage.local.set({ syncPending: true, syncPendingAt: Date.now() });
    const tabs = await browser.tabs.query({ url: "*://www.youtube.com/*" });
    if (!tabs.length) {
      await browser.tabs.create({ url: "https://www.youtube.com/" });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const progress = await browser.storage.local.get("syncProgress");
    if (!progress.syncProgress) {
      await browser.tabs.create({ url: "https://www.youtube.com/" });
    }
  });
  clear.addEventListener("click", async () => {
    if (window.confirm("Очистить весь список подписок?")) {
      await browser.storage.local.set({
        channels: { ids: [], handles: [], names: [] },
        syncedAt: null
      });
      await refresh();
    }
  });
  browser.storage.onChanged.addListener(refresh);
  refresh();
}());
