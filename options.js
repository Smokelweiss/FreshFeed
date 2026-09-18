(function () {
  "use strict";

  const settingControls = {
    hideSubscribedChannels: document.getElementById("hide-subscribed"),
    hideShorts: document.getElementById("hide-shorts"),
    hidePlayables: document.getElementById("hide-playables"),
    hideBlacklisted: document.getElementById("hide-blacklisted"),
    hideMembersOnly: document.getElementById("hide-members-only"),
    hideMixRadio: document.getElementById("hide-mix-radio"),
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
    hideSubscribedChannels: true,
    hideShorts: true,
    hidePlayables: true,
    hideBlacklisted: true,
    hideMembersOnly: false,
    hideMixRadio: false,
    filterUploadDate: false,
    uploadDateMode: "olderThan",
    uploadDateUnit: "days",
    uploadDateValue: 30,
    uploadDateMin: 1,
    uploadDateMax: 30,
    filterDuration: false,
    durationMode: "longerThan",
    durationUnit: "minutes",
    durationValue: 60,
    durationMin: 1,
    durationMax: 60
  };
  const channelKeys = ["ids", "handles", "customUrls", "names"];
  const allStorageKeys = [
    "channels", "blockedChannels", "syncedAt", "syncProgress", "syncPending", "lastSyncResult",
    ...Object.keys(settingControls), ...Object.keys(numericControls), ...Object.keys(selectControls)
  ];
  const count = document.getElementById("count");
  const synced = document.getElementById("synced");
  const progressWrap = document.getElementById("progress-wrap");
  const progressText = document.getElementById("progress-text");
  const result = document.getElementById("result");
  const sync = document.getElementById("sync");
  const clear = document.getElementById("clear");
  const copyResult = document.getElementById("copy-result");
  const blacklistText = document.getElementById("blacklist-text");
  const blacklistFile = document.getElementById("blacklist-file");
  const blacklistStatus = document.getElementById("blacklist-status");

  function emptyChannels() {
    return { ids: [], handles: [], customUrls: [], names: [] };
  }

  function channelsOf(value) {
    const source = value && typeof value === "object" ? value : {};
    return Object.fromEntries(channelKeys.map((key) => [key, Array.isArray(source[key]) ? source[key] : []]));
  }

  function channelCount(channels) {
    if (channels.ids.length) {
      return channels.ids.length;
    }
    return Math.max(...channelKeys.map((key) => channels[key].length), 0);
  }

  function settingsOf(data) {
    return { ...defaults, ...data };
  }

  function setStatus(message, isError) {
    blacklistStatus.textContent = message;
    blacklistStatus.classList.toggle("error", Boolean(isError));
  }

  function render(data) {
    const settings = settingsOf(data);
    Object.entries(settingControls).forEach(([key, control]) => { control.checked = settings[key] === true; });
    Object.entries(numericControls).forEach(([key, control]) => {
      control.value = Number(settings[key]) || (key.includes("Min") ? 1 : key.includes("Date") ? 30 : 60);
    });
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
    const channels = channelsOf(data.channels);
    const blockedChannels = channelsOf(data.blockedChannels);
    count.textContent = "Subscribed channels: " + channelCount(channels) + " · Blacklisted channels: " + channelCount(blockedChannels);
    synced.textContent = "Last sync: " + (data.syncedAt ? new Date(data.syncedAt).toLocaleString("en-US") : "never");
    progressWrap.hidden = !data.syncProgress;
    if (data.syncProgress) progressText.textContent = "Syncing… found " + (data.syncProgress.count || 0);
    sync.disabled = Boolean(data.syncProgress || data.syncPending);
    result.textContent = data.lastSyncResult || "No sync details.";
  }

  async function refresh() {
    render(await browser.storage.local.get(allStorageKeys));
  }

  function normalize(value) {
    return String(value || "").trim().toLowerCase();
  }

  function addIdentity(state, value) {
    const raw = String(value || "").trim();
    if (!raw || raw.startsWith("#")) return;
    let candidate = raw.replace(/^["']|["']$/g, "").trim();
    candidate = candidate.replace(/^https?:\/\/(?:www\.)?youtube\.com\//i, "");
    candidate = candidate.split(/[?#\s]/)[0].replace(/^\/+|\/+$/g, "");
    if (/^channel\/UC[\w-]+$/i.test(candidate)) state.ids.add(candidate.slice("channel/".length).toLowerCase());
    else if (/^UC[\w-]+$/i.test(candidate)) state.ids.add(candidate.toLowerCase());
    else if (/^@[^/\s]+$/.test(candidate)) state.handles.add(candidate.toLowerCase());
    else if (/^(?:c|user)\/[^/\s]+$/i.test(candidate)) state.customUrls.add(candidate.toLowerCase());
    else if (/^youtube\.com\/(?:@|channel\/|c\/|user\/)/i.test(raw)) addIdentity(state, raw.replace(/^youtube\.com\//i, ""));
    else if (candidate && !candidate.includes("/") && !candidate.includes(",")) state.names.add(normalize(candidate));
  }

  function collectFromValue(value, state, depth) {
    if (depth > 8 || value === null || value === undefined) return;
    if (typeof value === "string") {
      value.split(/\r?\n/).forEach((line) => addIdentity(state, line));
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => collectFromValue(item, state, depth + 1));
      return;
    }
    if (typeof value !== "object") return;
    const preferredKeys = ["id", "channelId", "browseId", "handle", "channelHandle", "url", "channelUrl", "customUrl", "name", "channelName"];
    preferredKeys.forEach((key) => {
      if (typeof value[key] === "string") addIdentity(state, value[key]);
    });
    ["ids", "handles", "customUrls", "names", "channels", "blockedChannels", "blacklist", "blacklistedChannels", "items", "data"].forEach((key) => {
      if (value[key] !== undefined) collectFromValue(value[key], state, depth + 1);
    });
  }

  function parseImportedText(text) {
    const state = { ids: new Set(), handles: new Set(), customUrls: new Set(), names: new Set() };
    const trimmed = String(text || "").trim();
    if (!trimmed) return state;
    try {
      collectFromValue(JSON.parse(trimmed), state, 0);
      return state;
    } catch {
      trimmed.split(/\r?\n/).forEach((line, index) => {
        const cells = line.split(",").map((cell) => cell.trim().replace(/^"|"$/g, ""));
        if (index === 0 && /^(?:type|kind|channelid|value|url)\s*,/i.test(line)) return;
        if (cells.length > 1 && /^(?:id|channelid|handle|customurl|url|name|channelname)$/i.test(cells[0])) {
          addIdentity(state, cells[1]);
        } else {
          cells.forEach((cell) => addIdentity(state, cell));
        }
      });
      return state;
    }
  }

  function mergeStates(first, second, replace) {
    const result = replace ? emptyChannels() : channelsOf(first);
    channelKeys.forEach((key) => {
      result[key] = Array.from(new Set([...(result[key] || []), ...Array.from(second[key])]));
    });
    return result;
  }

  function exportLines(channels) {
    const lines = [];
    channels.ids.forEach((id) => lines.push("https://www.youtube.com/channel/" + id));
    channels.handles.forEach((handle) => lines.push("https://www.youtube.com/" + handle));
    channels.customUrls.forEach((url) => lines.push("https://www.youtube.com/" + url));
    channels.names.forEach((name) => lines.push(name));
    return lines.join("\n") + (lines.length ? "\n" : "");
  }

  function exportContent(channels, format) {
    if (format === "json") {
      return JSON.stringify({ channels: channels, source: "FreshFeed", version: 1 }, null, 2);
    }
    if (format === "csv") {
      return "type,value\n" +
        channels.ids.map((value) => "channelId," + value).join("\n") +
        (channels.ids.length ? "\n" : "") +
        channels.handles.map((value) => "handle," + value).join("\n") +
        (channels.handles.length ? "\n" : "") +
        channels.customUrls.map((value) => "customUrl," + value).join("\n") +
        (channels.customUrls.length ? "\n" : "") +
        channels.names.map((value) => "name," + JSON.stringify(value)).join("\n") +
        (channels.names.length ? "\n" : "");
    }
    return exportLines(channels);
  }

  function downloadText(filename, content, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function importBlacklist(replace) {
    const parsed = parseImportedText(blacklistText.value);
    if (!parsed.ids.size && !parsed.handles.size && !parsed.customUrls.size && !parsed.names.size) {
      setStatus("No supported channel identities found.", true);
      return;
    }
    const saved = await browser.storage.local.get("blockedChannels");
    const blockedChannels = mergeStates(saved.blockedChannels, parsed, replace);
    await browser.storage.local.set({ blockedChannels });
    blacklistText.value = "";
    setStatus((replace ? "Replaced" : "Added") + " blacklist with " + channelCount(parsed) + " imported identities.", false);
    await refresh();
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
    await browser.storage.local.set({ channels: emptyChannels(), syncedAt: null, initialSyncDone: false });
    refresh();
  });
  document.getElementById("clear-blacklist").addEventListener("click", async () => {
    if (!window.confirm("Clear the entire blacklist?")) return;
    await browser.storage.local.set({ blockedChannels: emptyChannels() });
    setStatus("Blacklist cleared.", false);
    refresh();
  });
  document.getElementById("export-blacklist").addEventListener("click", async () => {
    const data = await browser.storage.local.get("blockedChannels");
    const channels = channelsOf(data.blockedChannels);
    const format = document.getElementById("blacklist-format").value;
    const extension = format === "json" ? "json" : format === "csv" ? "csv" : "txt";
    const mime = format === "json" ? "application/json" : format === "csv" ? "text/csv" : "text/plain";
    downloadText("freshfeed-blacklist." + extension, exportContent(channels, format), mime);
    setStatus("Blacklist exported.", false);
  });
  document.getElementById("import-merge").addEventListener("click", () => importBlacklist(false));
  document.getElementById("import-replace").addEventListener("click", () => importBlacklist(true));
  blacklistFile.addEventListener("change", async () => {
    const file = blacklistFile.files[0];
    if (!file) return;
    blacklistText.value = await file.text();
    setStatus("File loaded. Choose Add to blacklist or Replace blacklist.", false);
    blacklistFile.value = "";
  });
  copyResult.addEventListener("click", async () => {
    await navigator.clipboard.writeText(result.textContent);
    copyResult.textContent = "Copied";
    setTimeout(() => { copyResult.textContent = "Copy details"; }, 1200);
  });
  browser.storage.onChanged.addListener(refresh);
  refresh();
}());
