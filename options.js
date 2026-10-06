(function () {
  "use strict";

  const settingControls = {
    hideSubscribedChannels: document.getElementById("hide-subscribed"),
    hideShorts: document.getElementById("hide-shorts"),
    hidePlayables: document.getElementById("hide-playables"),
    hideBlacklisted: document.getElementById("hide-blacklisted"),
    hideMembersOnly: document.getElementById("hide-members-only"),
    hideMixRadio: document.getElementById("hide-mix-radio"),
    hideTopicShelves: document.getElementById("hide-topic-shelves"),
    hideLiveStreams: document.getElementById("hide-live-streams"),
    hideCommunityPosts: document.getElementById("hide-community-posts"),
    hideStorefrontShelves: document.getElementById("hide-storefront-shelves"),
    hidePromoShelves: document.getElementById("hide-promo-shelves"),
    hideSurveys: document.getElementById("hide-surveys"),
    hideGeneratedShelves: document.getElementById("hide-generated-shelves"),
    bgPreload: document.getElementById("bg-preload"),
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
    hideTopicShelves: false,
    hideLiveStreams: false,
    hideCommunityPosts: false,
    hideStorefrontShelves: false,
    hidePromoShelves: false,
    hideSurveys: false,
    hideGeneratedShelves: false,
    bgPreload: true,
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
    "channels", "blockedChannels", "enabled", "syncedAt", "syncProgress", "syncPending", "lastSyncResult",
    "feedDiag",
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
  const enabledControl = document.getElementById("enabled");
  const filtersSummary = document.getElementById("filters-summary");
  const subscribedList = document.getElementById("subscribed-list");
  const blacklistList = document.getElementById("blacklist-list");
  const blacklistCount = document.getElementById("blacklist-count");
  const settingLabels = {
    hideSubscribedChannels: "Subscribed channels",
    hideShorts: "Shorts",
    hidePlayables: "Playables",
    hideBlacklisted: "Blacklisted channels",
    hideMembersOnly: "Members-only videos",
    hideMixRadio: "Mix / Radio playlists",
    hideTopicShelves: "More topics shelves",
    hideLiveStreams: "Live & upcoming streams",
    hideCommunityPosts: "Community posts",
    hideStorefrontShelves: "Movies & storefront",
    hidePromoShelves: "Brand & promo banners",
    hideSurveys: "Surveys & upsell popups",
    hideGeneratedShelves: "Generated topic shelves",
    bgPreload: "Background feed preload (loads ahead of your scroll)",
    filterUploadDate: "Upload date",
    filterDuration: "Duration"
  };

  // --- Tab navigation ----------------------------------------------------
  const tabs = Array.from(document.querySelectorAll(".tab"));
  const panels = Array.from(document.querySelectorAll(".panel"));

  function selectTab(tab) {
    const panelId = tab.getAttribute("aria-controls");
    tabs.forEach((item) => item.setAttribute("aria-selected", String(item === tab)));
    panels.forEach((panel) => { panel.hidden = panel.id !== panelId; });
    if (window.location.hash.slice(1) !== tab.id) {
      try {
        window.history.replaceState(null, "", "#" + tab.id);
      } catch (error) {
        // history may be unavailable in some embedded contexts.
      }
    }
  }

  tabs.forEach((tab) => tab.addEventListener("click", () => selectTab(tab)));

  function selectTabFromHash() {
    const hash = window.location.hash.slice(1);
    const tab = tabs.find((item) => item.id === hash);
    selectTab(tab || tabs[0]);
  }
  window.addEventListener("hashchange", selectTabFromHash);

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

  // The four identity pools (ids / handles / customUrls / names) describe the
  // SAME channels from different angles. Rendering them as separate rows made
  // one channel look like four, and removing a row only dropped one pool, so
  // the channel stayed half-present. Group them into one row per channel:
  // a name links to a handle, which links to an id.
  function groupIdentities(channels) {
    const groups = [];
    const findGroupFor = (entry) => groups.find((group) => {
      if (entry.id && group.ids.has(entry.id)) return true;
      if (entry.handle && group.handles.has(entry.handle)) return true;
      if (entry.customUrl && group.customUrls.has(entry.customUrl)) return true;
      if (entry.name && group.names.has(entry.name)) return true;
      return false;
    });

    const add = (key, value) => {
      const entry = { [key]: value };
      const group = findGroupFor(entry);
      if (group) {
        group[key].add(value);
      } else {
        groups.push({
          ids: new Set(key === "id" ? [value] : []),
          handles: new Set(key === "handle" ? [value] : []),
          customUrls: new Set(key === "customUrl" ? [value] : []),
          names: new Set(key === "name" ? [value] : [])
        });
      }
    };

    // Add ids first so handles/names can attach to the same channel.
    channels.ids.forEach((id) => add("id", id));
    channels.handles.forEach((handle) => add("handle", handle));
    channels.customUrls.forEach((customUrl) => add("customUrl", customUrl));
    channels.names.forEach((name) => add("name", name));
    return groups;
  }

  function groupLabel(group) {
    const handle = group.handles.values().next().value;
    if (handle) return group.names.values().next().value
      ? `${group.names.values().next().value} (${handle})`
      : handle;
    const name = group.names.values().next().value;
    if (name) return name;
    const customUrl = group.customUrls.values().next().value;
    if (customUrl) return "/" + customUrl;
    return group.ids.values().next().value || "(unknown channel)";
  }

  function renderChannelList(container, channels, onRemove, limit) {
    const groups = groupIdentities(channels);
    container.replaceChildren();
    if (!groups.length) {
      const empty = document.createElement("p");
      empty.className = "empty-note";
      empty.textContent = channels.ids.length || channels.handles.length || channels.customUrls.length || channels.names.length
        ? "Nothing to show."
        : "Nothing stored yet.";
      container.appendChild(empty);
      return;
    }
    const shown = groups.slice(0, limit);
    shown.forEach((group) => {
      const row = document.createElement("div");
      row.className = "channel-item";

      const label = document.createElement("span");
      label.className = "channel-name";
      label.textContent = groupLabel(group);
      const id = group.ids.values().next().value;
      if (id) label.title = id;

      row.append(label);

      if (onRemove) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "icon-button";
        remove.textContent = "Remove";
        remove.setAttribute("aria-label", "Remove " + groupLabel(group));
        remove.addEventListener("click", (event) => {
          // Stop the click from bubbling into <summary>, which would toggle the
          // disclosure shut and hide the very list being edited.
          event.preventDefault();
          event.stopPropagation();
          onRemove(group);
        });
        row.appendChild(remove);
      }

      container.appendChild(row);
    });
    if (groups.length > shown.length) {
      const more = document.createElement("p");
      more.className = "empty-note";
      more.textContent = "+" + (groups.length - shown.length) + " more not shown.";
      container.appendChild(more);
    }
  }

  async function removeBlacklistEntry(group) {
    const saved = await browser.storage.local.get("blockedChannels");
    const channels = channelsOf(saved.blockedChannels);
    // Remove every identity that belongs to this channel, not just the one the
    // row happened to be built from.
    channels.ids = channels.ids.filter((value) => !group.ids.has(value));
    channels.handles = channels.handles.filter((value) => !group.handles.has(value));
    channels.customUrls = channels.customUrls.filter((value) => !group.customUrls.has(value));
    channels.names = channels.names.filter((value) => !group.names.has(value));
    await browser.storage.local.set({ blockedChannels: channels });
    setStatus("Removed " + groupLabel(group) + " from the blacklist.", false);
    // Re-render from the value just written, so the row disappears immediately
    // even if the storage.onChanged listener has not fired yet.
    render(await browser.storage.local.get(allStorageKeys));
  }

  // Plain-text report of what the extension actually saw on the page. The two
  // Diagnostics: what the content script actually sees, shown on the
  // options page so a feature that is not running says why instead of
  // leaving the user to guess. Covers the filter, the background preload
  // and subscription sync.
  function renderDiagnostics(data) {
    const lines = [];
    lines.push(data.lastSyncResult || "No sync details.");
    lines.push("");
    const d = data.feedDiag;
    if (!d || !d.updatedAt) {
      lines.push("Nothing observed yet. Open the YouTube home page, wait a moment,");
      lines.push("then reopen this tab. If this stays empty the content script");
      lines.push("is not running, which is a different problem.");
      return lines.join("\n");
    }
    const when = new Date(d.updatedAt).toLocaleString();
    const yes = (v) => (v ? "yes" : "no");
    lines.push("observed: " + when + " on " + (d.page || "?"));
    lines.push("");
    lines.push("Filter");
    lines.push("  cards checked      : " + (d.checked || 0));
    lines.push("  cards hidden       : " + (d.hidden || 0));
    lines.push("");
    lines.push("Background feed preload (native, no fabricated cards)");
    lines.push("  active             : " + yes(d.preloadActive) + (d.preloadGate ? "   ← " + d.preloadGate : ""));
    lines.push("  setting            : " + yes(d.preloadSetting));
    lines.push("  hook found         : " + (d.preloadHook || "?") +
      (d.preloadHook === "sentinel"
        ? "   (sentinel present - preload can grow the feed)"
        : d.preloadHook === "none"
          ? "   (no continuation sentinel - nothing to wake)"
          : d.preloadHook.startsWith("ytd-continuation-item-renderer")
            ? "   (sentinel found but nudge didn't grow this round)"
            : ""));
    lines.push("  rounds run         : " + (d.preloadRounds || 0));
    lines.push("  pages that grew    : " + (d.preloadGrowth || 0));
    lines.push("  dead rounds        : " + (d.preloadDeadRounds || 0));
    lines.push("  last strategy      : " + (d.preloadStrategy || "none"));
    lines.push("  nudge: " + (d.nudgeAttempts || 0) + " attempts, " + (d.nudgeSuccesses || 0) + " grew the feed");
    lines.push("  buffer screens     : " + (d.bufferScreens != null ? d.bufferScreens.toFixed(1) : "?"));
    lines.push("  page moved by preload: never (preload only nudges the sentinel, it never scrolls)");
    lines.push("");
    lines.push("Subscription sync");
    lines.push("  channels           : " + (d.syncChannels || 0));
    lines.push("  reported partial   : " + yes(d.syncPartial));
    lines.push("  pages unavailable  : " + (d.syncSkippedPages || 0));
    return lines.join("\n");
  }


  function render(data) {
    const settings = settingsOf(data);
    enabledControl.checked = data.enabled !== false;
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
    const activeFilters = Object.entries(settingLabels)
      .filter(([key]) => settings[key])
      .map(([, label]) => label);
    filtersSummary.textContent = activeFilters.length
      ? "Active filters: " + activeFilters.join(", ") + "."
      : "No filters enabled. FreshFeed will not hide anything.";
    filtersSummary.hidden = false;
    const channels = channelsOf(data.channels);
    const blockedChannels = channelsOf(data.blockedChannels);
    count.textContent = "Subscribed channels: " + channelCount(channels) + " · Blacklisted channels: " + channelCount(blockedChannels);
    synced.textContent = "Last sync: " + (data.syncedAt ? new Date(data.syncedAt).toLocaleString() : "never");
    progressWrap.hidden = !data.syncProgress;
    if (data.syncProgress) progressText.textContent = "Syncing… found " + (data.syncProgress.count || 0);
    sync.disabled = Boolean(data.syncProgress || data.syncPending);
    result.textContent = renderDiagnostics(data);
    blacklistCount.textContent = String(channelCount(blockedChannels));
    renderChannelList(subscribedList, channels, null, 200);
    renderChannelList(blacklistList, blockedChannels, removeBlacklistEntry, 200);
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
    // Queue the sync for the background worker. Never open or switch tabs: the
    // user asked for a sync, not for their browser to be moved around.
    await browser.storage.local.set({ syncPending: true, syncPendingAt: Date.now() });
    // Ask any already-open YouTube tab to run it right away, if one exists.
    try {
      const tabs = await browser.tabs.query({ url: "*://www.youtube.com/*" });
      if (tabs.length) {
        // The content script listens for this and starts the sync itself.
        browser.tabs.sendMessage(tabs[0].id, { type: "freshfeed-run-sync" }).catch(() => {});
      } else {
        setStatus("Sync queued. It will run the next time you open YouTube.", false);
      }
    } catch (error) {
      setStatus("Sync queued. It will run the next time you open YouTube.", false);
    }
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
  enabledControl.addEventListener("change", () => browser.storage.local.set({ enabled: enabledControl.checked }).then(refresh));
  browser.storage.onChanged.addListener(refresh);
  selectTabFromHash();
  refresh();
}());
