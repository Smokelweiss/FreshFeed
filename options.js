(function () {
  "use strict";

  const settingControls = {
    filterUploadDate: document.getElementById("filter-upload-date"),
    filterDuration: document.getElementById("filter-duration")
  };
  const numericControls = {
    uploadDateValue: document.getElementById("upload-date-value"),
    uploadDateMin: document.getElementById("upload-date-min"),
    uploadDateMax: document.getElementById("upload-date-max"),
    durationValue: document.getElementById("duration-value"),
    durationMin: document.getElementById("duration-min"),
    durationMax: document.getElementById("duration-max")
  };
  const selectControls = {
    uploadDateMode: document.getElementById("upload-date-mode"),
    uploadDateUnit: document.getElementById("upload-date-unit"),
    durationMode: document.getElementById("duration-mode"),
    durationUnit: document.getElementById("duration-unit")
  };
  const defaults = {
    filterUploadDate: false, uploadDateMode: "olderThan", uploadDateUnit: "days",
    uploadDateValue: 30, uploadDateMin: 1, uploadDateMax: 30,
    filterDuration: false, durationMode: "longerThan", durationUnit: "minutes",
    durationValue: 60, durationMin: 1, durationMax: 60
  };
  const count = document.getElementById("count");
  const synced = document.getElementById("synced");
  const progressWrap = document.getElementById("progress-wrap");
  const progressText = document.getElementById("progress-text");
  const result = document.getElementById("result");
  const sync = document.getElementById("sync");
  const clear = document.getElementById("clear");
  const copyResult = document.getElementById("copy-result");

  function channelsOf(value) {
    return value && typeof value === "object" ? value : { ids: [], handles: [], customUrls: [], names: [] };
  }
  function channelCount(channels) {
    return (channels.ids || []).length || Math.max((channels.handles || []).length, (channels.customUrls || []).length, (channels.names || []).length);
  }
  function settingsOf(data) {
    return { ...defaults, ...data };
  }
  function render(data) {
    const settings = settingsOf(data);
    Object.entries(settingControls).forEach(([key, control]) => { control.checked = settings[key] !== false; });
    Object.entries(numericControls).forEach(([key, control]) => { control.value = Number(settings[key]) || (key.includes("Min") ? 1 : key.includes("Date") ? 30 : 60); });
    Object.entries(selectControls).forEach(([key, control]) => { control.value = settings[key]; });
    const uploadDateOptions = document.getElementById("upload-date-options");
    const durationOptions = document.getElementById("duration-options");
    uploadDateOptions.hidden = !settings.filterUploadDate;
    durationOptions.hidden = !settings.filterDuration;
    uploadDateOptions.setAttribute("aria-hidden", String(!settings.filterUploadDate));
    durationOptions.setAttribute("aria-hidden", String(!settings.filterDuration));
    document.getElementById("upload-date-between").hidden = settings.uploadDateMode !== "between";
    document.getElementById("duration-between").hidden = settings.durationMode !== "between";
    document.querySelector(".unit-label").textContent = settings.uploadDateUnit;
    document.querySelector(".duration-unit-label").textContent = settings.durationUnit;
    count.textContent = "Subscribed: " + channelCount(channelsOf(data.channels)) + " · Blacklisted: " + channelCount(channelsOf(data.blockedChannels));
    synced.textContent = "Last sync: " + (data.syncedAt ? new Date(data.syncedAt).toLocaleString("en-US") : "never");
    progressWrap.hidden = !data.syncProgress;
    if (data.syncProgress) progressText.textContent = "Syncing… found " + (data.syncProgress.count || 0);
    sync.disabled = Boolean(data.syncProgress || data.syncPending);
    result.textContent = data.lastSyncResult || "No sync details.";
  }
  async function refresh() {
    render(await browser.storage.local.get(["channels", "blockedChannels", "syncedAt", "syncProgress", "syncPending", "lastSyncResult", ...Object.keys(settingControls), ...Object.keys(numericControls), ...Object.keys(selectControls)]));
  }
  Object.entries(settingControls).forEach(([key, control]) => control.addEventListener("change", () => browser.storage.local.set({ [key]: control.checked }).then(refresh)));
  Object.entries(numericControls).forEach(([key, control]) => control.addEventListener("change", () => {
    const value = Math.max(Number(control.min), Math.min(Number(control.max), Number(control.value) || Number(control.min)));
    control.value = value;
    browser.storage.local.set({ [key]: value }).then(refresh);
  }));
  Object.entries(selectControls).forEach(([key, control]) => control.addEventListener("change", () => browser.storage.local.set({ [key]: control.value }).then(refresh)));
  sync.addEventListener("click", async () => {
    await browser.storage.local.set({ syncPending: true, syncPendingAt: Date.now() });
    const tabs = await browser.tabs.query({ url: "*://www.youtube.com/*" });
    if (!tabs.length) await browser.tabs.create({ url: "https://www.youtube.com/" });
    refresh();
  });
  clear.addEventListener("click", async () => {
    if (!window.confirm("Clear the entire subscribed-channel list?")) return;
    await browser.storage.local.set({ channels: { ids: [], handles: [], customUrls: [], names: [] }, syncedAt: null, initialSyncDone: false });
    refresh();
  });
  copyResult.addEventListener("click", async () => {
    await navigator.clipboard.writeText(result.textContent);
    copyResult.textContent = "Copied";
    setTimeout(() => { copyResult.textContent = "Copy details"; }, 1200);
  });
  browser.storage.onChanged.addListener(refresh);
  refresh();
}());
