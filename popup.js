(function () {
  "use strict";

  const settingControls = {
    hideSubscribedChannels: document.getElementById("hide-subscribed"),
    hideShorts: document.getElementById("hide-shorts"),
    filterRecommendations: document.getElementById("filter-recommendations"),
    updateAfterSubscriptionChange: document.getElementById("update-subscriptions"),
    hidePlayables: document.getElementById("hide-playables"),
    hideMembersOnly: document.getElementById("hide-members-only"),
    hideMixRadio: document.getElementById("hide-mix-radio"),
    filterUploadDate: document.getElementById("filter-upload-date"),
    filterDuration: document.getElementById("filter-duration")
  };
  const numericControls = {
    uploadDateDays: document.getElementById("upload-date-days"),
    maxDurationMinutes: document.getElementById("max-duration-minutes")
  };
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
    return value && typeof value === "object" ? value : { ids: [], handles: [], customUrls: [], names: [] };
  }

  function channelCount(channels) {
    return (channels.ids || []).length || Math.max((channels.handles || []).length, (channels.customUrls || []).length, (channels.names || []).length);
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
    const blocked = channelsOf(data.blockedChannels);
    const settings = {
      hideSubscribedChannels: true,
      hideShorts: true,
      filterRecommendations: true,
      updateAfterSubscriptionChange: true,
      hidePlayables: false,
      hideMembersOnly: false,
      hideMixRadio: false,
      filterUploadDate: false,
      uploadDateDays: 30,
      filterDuration: false,
      maxDurationMinutes: 60,
      ...data
    };
    Object.entries(settingControls).forEach(([key, control]) => {
      control.checked = settings[key] !== false;
    });
    Object.entries(numericControls).forEach(([key, control]) => {
      control.value = Number(settings[key]) || (key === "uploadDateDays" ? 30 : 60);
    });
    count.textContent = "Subscribed: " + channelCount(channels) + " · Blacklisted: " + channelCount(blocked);
    synced.textContent = "Last sync: " + (data.syncedAt ? new Date(data.syncedAt).toLocaleString("en-US") : "never");
    progressWrap.hidden = !progress;
    if (progress) {
      progressText.textContent = "Syncing… found " + (progress.count || 0);
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
    render(await browser.storage.local.get(["channels", "blockedChannels", "syncedAt", "syncProgress", "syncPending", "syncPendingAt", "lastSyncResult", ...Object.keys(settingControls), ...Object.keys(numericControls)]));
  }

  Object.entries(settingControls).forEach(([key, control]) => {
    control.addEventListener("change", () => browser.storage.local.set({ [key]: control.checked }));
  });
  Object.entries(numericControls).forEach(([key, control]) => {
    control.addEventListener("change", () => {
      const value = Math.max(Number(control.min), Math.min(Number(control.max), Number(control.value) || Number(control.min)));
      control.value = value;
      browser.storage.local.set({ [key]: value });
    });
  });
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
    if (window.confirm("Clear the entire subscription list?")) {
      await browser.storage.local.set({
        channels: { ids: [], handles: [], customUrls: [], names: [] },
        syncedAt: null,
        initialSyncDone: false
      });
      await refresh();
    }
  });
  browser.storage.onChanged.addListener(refresh);
  refresh();
}());
