(function () {
  "use strict";

  const CARD_SELECTOR = "ytd-rich-item-renderer, ytd-rich-grid-media, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer, ytd-rich-shelf-renderer, ytd-reel-item-renderer";
  const CHANNEL_LINK_SELECTOR = 'a[href*="/@"], a[href*="/channel/"], a[href*="/c/"], a[href*="/user/"]';
  const DEFAULT_CHANNELS = { ids: [], handles: [], customUrls: [], names: [], records: [] };
  const DEFAULT_SETTINGS = {
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
  let state = {
    enabled: true,
    channels: DEFAULT_CHANNELS,
    blockedChannels: DEFAULT_CHANNELS,
    settings: DEFAULT_SETTINGS,
    syncedAt: null,
    syncPending: false,
    syncLock: null,
    syncProgress: null,
    syncFallback: false
  };
  let ids = new Set();
  let handles = new Set();
  let customUrls = new Set();
  let names = new Set();
  let blockedIds = new Set();
  let blockedHandles = new Set();
  let blockedCustomUrls = new Set();
  let blockedNames = new Set();
  let homeObserver = null;
  let homeTimer = null;
  let homeActive = false;
  let syncRunning = false;
  let fallbackRunning = false;
  let dynamicTimer = null;
  let lastMenuContext = null;
  let videoMenuObserver = null;

  function normName(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function parseChannelHref(href) {
    if (!href) {
      return {};
    }
    let url;
    try {
      url = new URL(href, location.origin);
    } catch (error) {
      return {};
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (!parts.length) {
      return {};
    }
    if (parts[0].toLowerCase() === "channel" && /^UC[\w-]+$/i.test(parts[1] || "")) {
      return { id: parts[1].toLowerCase() };
    }
    if (parts[0].startsWith("@")) {
      return { handle: parts[0].toLowerCase() };
    }
    if ((parts[0] === "c" || parts[0] === "user") && parts[1]) {
      return { customUrl: parts[0] + "/" + parts[1].toLowerCase() };
    }
    return {};
  }

  function normCustomUrl(value) {
    const normalized = String(value || "").trim().toLowerCase().replace(/^\/|\/$/g, "");
    return /^(?:c|user)\/[^/]+$/.test(normalized) ? normalized : "";
  }

  function normalizeChannelState(channels) {
    const source = channels && typeof channels === "object" ? channels : {};
    return {
      ids: Array.from(new Set(Array.isArray(source.ids) ? source.ids.map((item) => String(item).toLowerCase()).filter((item) => /^uc[\w-]+$/i.test(item)) : [])),
      handles: Array.from(new Set(Array.isArray(source.handles) ? source.handles.map((item) => String(item).toLowerCase()).filter((item) => /^@[^/]+$/.test(item)) : [])),
      customUrls: Array.from(new Set(Array.isArray(source.customUrls) ? source.customUrls.map(normCustomUrl).filter(Boolean) : [])),
      names: Array.from(new Set(Array.isArray(source.names) ? source.names.map(normName).filter(Boolean) : [])),
      records: Array.isArray(source.records) ? source.records.filter((item) => item && typeof item === "object") : []
    };
  }

  function normalizeSettings(saved) {
    const source = saved && typeof saved === "object" ? saved : {};
    const migrated = {
      ...source,
      uploadDateValue: source.uploadDateValue ?? source.uploadDateDays,
      durationValue: source.durationValue ?? (source.maxDurationMinutes ?? 60)
    };
    return Object.fromEntries(Object.entries(DEFAULT_SETTINGS).map(([key, fallback]) => {
      if (!Object.prototype.hasOwnProperty.call(migrated, key) || migrated[key] === undefined) {
        return [key, key === "hideSubscribedChannels" ? migrated.enabled !== false : fallback];
      }
      if (typeof fallback === "boolean") return [key, migrated[key] !== false];
      if (typeof fallback === "number") return [key, Number.isFinite(Number(migrated[key])) ? Number(migrated[key]) : fallback];
      return [key, typeof migrated[key] === "string" && migrated[key] ? migrated[key] : fallback];
    }));
  }

  function updateSets() {
    state.channels = normalizeChannelState(state.channels);
    state.blockedChannels = normalizeChannelState(state.blockedChannels);
    state.settings = normalizeSettings(state.settings);
    ids = new Set(state.channels.ids);
    handles = new Set(state.channels.handles);
    customUrls = new Set(state.channels.customUrls);
    names = new Set(state.channels.names);
    blockedIds = new Set(state.blockedChannels.ids);
    blockedHandles = new Set(state.blockedChannels.handles);
    blockedCustomUrls = new Set(state.blockedChannels.customUrls);
    blockedNames = new Set(state.blockedChannels.names);
    publishPageFilterIndex();
  }

  function publishPageFilterIndex() {
    window.postMessage({
      source: "freshfeed-content",
      type: "index",
      index: {
        ids: state.channels.ids,
        handles: state.channels.handles,
        customUrls: state.channels.customUrls,
        names: state.channels.names
      },
      blockedIndex: {
        ids: state.blockedChannels.ids,
        handles: state.blockedChannels.handles,
        customUrls: state.blockedChannels.customUrls,
        names: state.blockedChannels.names
      },
      settings: state.settings
    }, "*");
  }

  function installPageFilter() {
    window.addEventListener("message", (event) => {
      if (event.source === window && event.data?.source === "freshfeed-page-filter" && event.data.type === "ready") {
        publishPageFilterIndex();
      }
    }, true);
    const script = document.createElement("script");
    script.src = browser.runtime.getURL("page-filter.js");
    script.async = false;
    (document.documentElement || document.head).appendChild(script);
    script.remove();
  }

  function titleOf(card) {
    const title = card.querySelector("#video-title, a#video-title-link, h3");
    return normName(title && (title.textContent || title.getAttribute("title") || title.getAttribute("aria-label")));
  }

  function walkEmbeddedData(value, depth, seen, result) {
    if (depth > 8 || result.ids.size + result.handles.size >= 12 || value === null || value === undefined) {
      return;
    }
    if (typeof value !== "object" || seen.has(value) || seen.size >= 400) {
      return;
    }
    seen.add(value);
    if (typeof value.browseId === "string" && /^UC[\w-]+$/i.test(value.browseId)) {
      result.ids.add(value.browseId.toLowerCase());
    }
    if (typeof value.channelId === "string" && /^UC[\w-]+$/i.test(value.channelId)) {
      result.ids.add(value.channelId.toLowerCase());
    }
    if (typeof value.canonicalBaseUrl === "string" && value.canonicalBaseUrl.startsWith("/@")) {
      const parsed = parseChannelHref(value.canonicalBaseUrl);
      if (parsed.handle) {
        result.handles.add(parsed.handle);
      }
    }
    Object.keys(value).some((key) => {
      walkEmbeddedData(value[key], depth + 1, seen, result);
      return seen.size >= 400;
    });
  }

  function extractChannel(card) {
    const result = { ids: new Set(), handles: new Set(), customUrls: new Set(), names: new Set() };
    card.querySelectorAll("a[href]").forEach((link) => {
      const parsed = parseChannelHref(link.getAttribute("href"));
      if (parsed.id) {
        result.ids.add(parsed.id);
      }
      if (parsed.handle) {
        result.handles.add(parsed.handle);
      }
      if (parsed.customUrl) {
        result.customUrls.add(parsed.customUrl);
      }
    });
    try {
      const embeddedSources = [
        card.wrappedJSObject && card.wrappedJSObject.data,
        card.wrappedJSObject && card.wrappedJSObject.__data,
        card.data,
        card.__data
      ];
      for (const source of embeddedSources) {
        if (source && typeof source === "object") {
          walkEmbeddedData(source, 0, new Set(), result);
        }
      }
    } catch (error) {
      // Firefox may restrict access to page-owned renderer data.
    }
    const nameSelectors = [
      "ytd-channel-name #text",
      "#channel-name #text",
      "#channel-name a",
      "ytd-channel-name a",
      "yt-lockup-metadata-view-model a",
      "yt-lockup-metadata-view-model yt-formatted-string",
      "ytd-video-meta-block #byline",
      "yt-formatted-string#text.ytd-channel-name",
      "yt-content-metadata-view-model .yt-content-metadata-view-model__metadata-text",
      "yt-content-metadata-view-model .yt-core-attributed-string"
    ];
    for (const selector of nameSelectors) {
      const element = card.querySelector(selector);
      const value = normName(element && element.textContent);
      if (value) {
        result.names.add(value);
        break;
      }
    }
    if (!result.ids.size && !result.handles.size && !result.customUrls.size && !result.names.size) {
      const fallbackName = normName(card.querySelector("#byline, #channel-name, ytd-channel-name, yt-lockup-metadata-view-model")?.textContent);
      if (fallbackName) result.names.add(fallbackName);
    }
    return result;
  }

  function hasChannelData(channel) {
    return channel.ids.size > 0 || channel.handles.size > 0 || channel.customUrls.size > 0 || channel.names.size > 0;
  }

  function matchesIndex(channel, index) {
    return Array.from(channel.ids).some((id) => index.ids.has(id)) ||
      Array.from(channel.handles).some((handle) => index.handles.has(handle)) ||
      Array.from(channel.customUrls || []).some((customUrl) => index.customUrls.has(customUrl)) ||
      Array.from(channel.names).some((name) => index.names.has(name));
  }

  function parseDurationSeconds(value) {
    const parts = String(value || "").trim().split(":").map(Number);
    if (!parts.length || parts.some((part) => !Number.isFinite(part))) return null;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return parts.length === 1 ? parts[0] : null;
  }

  function ageInDays(value) {
    const match = String(value || "").toLowerCase().match(/(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/);
    if (!match) return null;
    const amount = Number(match[1]);
    const unit = match[2];
    const multipliers = {
      second: 1 / 86400,
      minute: 1 / 1440,
      hour: 1 / 24,
      day: 1,
      week: 7,
      month: 30,
      year: 365
    };
    return amount * multipliers[unit];
  }

  function cardContentFlags(card) {
    const text = normName(card && card.textContent);
    const aria = normName(card && (card.getAttribute("aria-label") || ""));
    const durationElement = card && card.querySelector(
      "ytd-thumbnail-overlay-time-status-renderer #text, " +
      "ytd-thumbnail-overlay-time-status-renderer span, " +
      ".badge-shape-wiz__text"
    );
    const durationSeconds = parseDurationSeconds(durationElement && durationElement.textContent);
    const metadata = card && card.querySelector("#metadata-line, ytd-video-meta-block, .ytd-video-meta-block");
    const daysOld = ageInDays(metadata && metadata.textContent);
    return {
      isPlayable: text.includes("playables") || aria.includes("playables") || card.matches("ytd-rich-shelf-renderer[is-playlist], ytd-playlist-renderer"),
      isMembersOnly: text.includes("members-only") || text.includes("members only") || Boolean(card.querySelector(".badge-style-type-members-only, ytd-badge-supported-renderer")),
      isMixRadio: card.matches("ytd-radio-renderer, ytd-compact-radio-renderer, ytd-playlist-renderer, ytd-compact-playlist-renderer") ||
        text.includes(" mix") || text.startsWith("mix ") || text.includes("radio"),
      durationSeconds,
      daysOld
    };
  }

  function dateUnitDays(unit) {
    return { days: 1, weeks: 7, months: 30, years: 365 }[unit] || 1;
  }

  function durationUnitSeconds(unit) {
    return { seconds: 1, minutes: 60, hours: 3600, days: 86400 }[unit] || 60;
  }

  function dateFilterMatches(daysOld) {
    const unitDays = dateUnitDays(state.settings.uploadDateUnit);
    const value = Number(state.settings.uploadDateValue) * unitDays;
    if (state.settings.uploadDateMode === "between") {
      const min = Number(state.settings.uploadDateMin) * unitDays;
      const max = Number(state.settings.uploadDateMax) * unitDays;
      return daysOld < Math.min(min, max) || daysOld > Math.max(min, max);
    }
    return daysOld > value;
  }

  function durationFilterMatches(seconds) {
    const unitSeconds = durationUnitSeconds(state.settings.durationUnit);
    const value = Number(state.settings.durationValue) * unitSeconds;
    if (state.settings.durationMode === "between") {
      const min = Number(state.settings.durationMin) * unitSeconds;
      const max = Number(state.settings.durationMax) * unitSeconds;
      return seconds < Math.min(min, max) || seconds > Math.max(min, max);
    }
    return seconds > value;
  }

  function shouldHideByContent(card) {
    const flags = cardContentFlags(card);
    if (flags.isPlayable && state.settings.hidePlayables) return true;
    if (flags.isMembersOnly && state.settings.hideMembersOnly) return true;
    if (flags.isMixRadio && state.settings.hideMixRadio) return true;
    if (state.settings.filterUploadDate && flags.daysOld !== null && dateFilterMatches(flags.daysOld)) return true;
    if (state.settings.filterDuration && flags.durationSeconds !== null && durationFilterMatches(flags.durationSeconds)) return true;
    return false;
  }

  function isHiddenChannel(channel, isShort) {
    const blockedMatch = matchesIndex(channel, {
      ids: blockedIds,
      handles: blockedHandles,
      customUrls: blockedCustomUrls,
      names: blockedNames
    });
    if (blockedMatch && state.settings.hideBlacklisted) {
      return true;
    }
    if (isShort && !state.settings.hideShorts) {
      return false;
    }
    const subscribedMatch = state.settings.hideSubscribedChannels && matchesIndex(channel, {
      ids,
      handles,
      customUrls,
      names
    });
    return subscribedMatch || (state.settings.hideBlacklisted && blockedMatch);
  }

  function isSubscribed(channel) {
    return Array.from(channel.ids).some((id) => ids.has(id)) ||
      Array.from(channel.handles).some((handle) => handles.has(handle)) ||
      Array.from(channel.customUrls || []).some((customUrl) => customUrls.has(customUrl)) ||
      Array.from(channel.names).some((name) => names.has(name));
  }

  function firstVideoHref(card) {
    const link = card.querySelector("a#video-title-link, a#thumbnail");
    return link ? link.href || link.getAttribute("href") || "" : "";
  }

  function markCard(card) {
    const href = firstVideoHref(card);
    const channel = extractChannel(card);
    if (!hasChannelData(channel) && !titleOf(card)) {
      return;
    }
    card.setAttribute("data-ff-checked", "1");
    card.setAttribute("data-ff-href", href);
    const isShort = card.matches("ytd-reel-item-renderer, ytd-rich-shelf-renderer, ytd-reel-shelf-renderer");
    if (state.enabled && (isHiddenChannel(channel, isShort) || shouldHideByContent(card))) {
      card.setAttribute("data-ff-hidden", "1");
    } else {
      card.removeAttribute("data-ff-hidden");
    }
  }

  function clearHiddenCards(clearChecked) {
    document.querySelectorAll("[data-ff-hidden='1']").forEach((card) => card.removeAttribute("data-ff-hidden"));
    if (clearChecked) {
      document.querySelectorAll("[data-ff-checked='1']").forEach((card) => {
        card.removeAttribute("data-ff-checked");
        card.removeAttribute("data-ff-href");
      });
    }
  }

  function isFilterSurface() {
    return location.pathname === "/" ||
      location.pathname.startsWith("/feed/") ||
      location.pathname.startsWith("/results");
  }

  function scanHome() {
    if (!homeActive || !state.enabled) {
      return;
    }
    document.querySelectorAll(CARD_SELECTOR + ":not([data-ff-checked])").forEach(markCard);
    document.querySelectorAll(CARD_SELECTOR + "[data-ff-checked='1']").forEach((card) => {
      const href = firstVideoHref(card);
      if (href !== card.getAttribute("data-ff-href")) {
        card.removeAttribute("data-ff-checked");
        markCard(card);
      }
    });
  }

  function scheduleHomeScan() {
    if (homeTimer) {
      clearTimeout(homeTimer);
    }
    homeTimer = setTimeout(() => {
      homeTimer = null;
      scanHome();
    }, 150);
  }

  function disconnectHome() {
    homeActive = false;
    if (homeObserver) {
      homeObserver.disconnect();
      homeObserver = null;
    }
    clearHiddenCards(false);
  }

  function connectHome() {
    if (!isFilterSurface() || !state.enabled) {
      disconnectHome();
      return;
    }
    homeActive = true;
    if (!homeObserver && document.documentElement) {
      homeObserver = new MutationObserver(scheduleHomeScan);
      homeObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
    scheduleHomeScan();
  }

  function updatePageMode() {
    if (isFilterSurface()) {
      connectHome();
    } else {
      disconnectHome();
    }
    if (location.pathname === "/feed/channels" && state.syncFallback) {
      startFallbackSync();
    }
    if (location.pathname.startsWith("/watch") || isFilterSurface()) {
      scheduleDynamicCheck();
      installVideoMenuObserver();
    }

    function installVideoMenuObserver() {
      if (videoMenuObserver || !document.documentElement) return;
      videoMenuObserver = new MutationObserver(() => injectVideoBlockMenuItem());
      videoMenuObserver.observe(document.documentElement, { childList: true, subtree: true });
      injectVideoBlockMenuItem();
    }

    function createBlockMenuItem(channel, card) {
      const item = document.createElement("ytd-menu-service-item-renderer");
      item.setAttribute("data-ff-video-block-channel", "1");
      item.setAttribute("role", "menuitem");
      item.setAttribute("aria-label", "Hide this channel");
      item.className = "style-scope ytd-menu-popup-renderer";
      item.style.cssText = "display:block;visibility:visible;opacity:1";
      const paperItem = document.createElement("tp-yt-paper-item");
      paperItem.className = "style-scope ytd-menu-service-item-renderer";
      paperItem.setAttribute("role", "option");
      paperItem.style.cssText = "display:flex;align-items:center;box-sizing:border-box;min-height:48px;padding:0 16px;visibility:visible;opacity:1;color:inherit;cursor:pointer";
      const icon = document.createElement("yt-icon");
      icon.className = "style-scope ytd-menu-service-item-renderer";
      icon.style.cssText = "margin-right:16px;width:24px;height:24px;display:inline-flex;color:#f00";
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("width", "24");
      svg.setAttribute("height", "24");
      svg.setAttribute("aria-hidden", "true");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("fill", "currentColor");
      path.setAttribute("d", "M5 3a1 1 0 0 1 1-1h12a1 1 0 0 1 .8 1.6L15.25 8l3.55 4.4A1 1 0 0 1 18 14H7v7H5V3Zm2 2v7h8.9l-2.75-3.4a1 1 0 0 1 0-1.2L15.9 5H7Z");
      svg.appendChild(path);
      icon.appendChild(svg);
      const label = document.createElement("span");
      label.id = "label";
      label.className = "style-scope ytd-menu-service-item-renderer";
      label.style.cssText = "display:block;flex:1;visibility:visible;opacity:1;color:#f00;font:inherit;white-space:nowrap";
      label.textContent = "Hide this channel";
      paperItem.append(icon, label);
      item.appendChild(paperItem);
      item.addEventListener("click", () => {
        addBlockedChannel(channel, card);
        item.remove();
      });
      return item;
    }

    function injectVideoBlockMenuItem() {
      const menu = document.querySelector("ytd-menu-popup-renderer #items, ytd-menu-popup-renderer tp-yt-paper-listbox, ytd-popup-container ytd-menu-popup-renderer");
      if (!menu || menu.querySelector("[data-ff-video-block-channel]")) return;
      if (location.pathname.startsWith("/watch")) {
        const channel = ownerChannel();
        if (hasChannelData(channel)) {
          menu.appendChild(createBlockMenuItem(channel, null));
        }
        return;
      }
      if (!isFilterSurface() || !lastMenuContext || Date.now() - lastMenuContext.at >= 10000) return;
      const card = lastMenuContext.card;
      const channel = lastMenuContext.channel && hasChannelData(lastMenuContext.channel)
        ? lastMenuContext.channel
        : extractChannel(card);
      if (card && hasChannelData(channel)) {
        menu.appendChild(createBlockMenuItem(channel, card));
      }
    }
  }

  function scheduleDynamicCheck() {
    if (dynamicTimer) {
      clearTimeout(dynamicTimer);
    }
    dynamicTimer = setTimeout(() => {
      dynamicTimer = null;
      checkDynamicChannel();
      setTimeout(checkDynamicChannel, 2000);
    }, 0);
  }

  function ownerChannel() {
    const owner = document.querySelector("ytd-video-owner-renderer");
    if (!owner) {
      return { ids: new Set(), handles: new Set(), customUrls: new Set(), names: new Set() };
    }
    const result = { ids: new Set(), handles: new Set(), customUrls: new Set(), names: new Set() };
    owner.querySelectorAll("a[href]").forEach((link) => {
      const parsed = parseChannelHref(link.getAttribute("href"));
      if (parsed.id) {
        result.ids.add(parsed.id);
      }
      if (parsed.handle) {
        result.handles.add(parsed.handle);
      }
      if (parsed.customUrl) {
        result.customUrls.add(parsed.customUrl);
      }
    });
    const name = normName(owner.querySelector("ytd-channel-name #text") && owner.querySelector("ytd-channel-name #text").textContent);
    if (name) {
      result.names.add(name);
    }
    return result;
  }

  function mergeChannel(channel, remove) {
    return mergeChannelCollection(state.channels, channel, remove);
  }

  function mergeChannelCollection(collection, channel, remove) {
    const next = {
      ids: new Set(collection.ids),
      handles: new Set(collection.handles),
      customUrls: new Set(collection.customUrls),
      names: new Set(collection.names)
    };
    const operation = remove ? "delete" : "add";
    channel.ids.forEach((value) => next.ids[operation](value));
    channel.handles.forEach((value) => next.handles[operation](value));
    (channel.customUrls || []).forEach((value) => next.customUrls[operation](value));
    channel.names.forEach((value) => next.names[operation](value));
    const channels = {
      ids: Array.from(next.ids),
      handles: Array.from(next.handles),
      customUrls: Array.from(next.customUrls),
      names: Array.from(next.names)
    };
    return { changed: JSON.stringify(collection) !== JSON.stringify(channels), channels };
  }

  async function addBlockedChannel(channel, card) {
    if (!hasChannelData(channel)) {
      return;
    }
    const result = mergeChannelCollection(state.blockedChannels, channel, false);
    if (!result.changed) {
      return;
    }
    try {
      state.blockedChannels = result.channels;
      updateSets();
      await browser.storage.local.set({
        blockedChannels: state.blockedChannels,
        lastBlockResult: "Added channel to blacklist"
      });
      if (card) {
        card.setAttribute("data-ff-hidden", "1");
      }
      scheduleHomeScan();
    } catch (error) {
      await browser.storage.local.set({
        lastBlockResult: "Could not save channel to blacklist: " + ((error && error.message) || "storage error")
      });
    }
  }

  function menuText(element) {
    return normName(
      element && (
        element.getAttribute("aria-label") ||
        element.getAttribute("title") ||
        element.textContent
      )
    );
  }

  function isNotInterestedItem(element) {
    const text = menuText(element);
    return text === "not interested" ||
      text === "не интересно" ||
      text === "не интересует" ||
      text === "не рекомендовать видео с данного канала" ||
      text === "не рекомендовать видео с этого канала";
  }

  function cardForElement(element) {
    return element && element.closest && element.closest(CARD_SELECTOR);
  }

  function observeNotInterestedAction(event) {
    const target = event.target && event.target.closest
      ? event.target.closest("ytd-menu-service-item-renderer, tp-yt-paper-item, [role='menuitem']")
      : null;
    const card = cardForElement(event.target);
    if (card && event.target.closest && event.target.closest("ytd-menu-button-renderer, ytd-menu-renderer, button[aria-label*='More'], button[aria-label*='more']")) {
      lastMenuContext = { card, channel: extractChannel(card), at: Date.now() };
    }
    if (!target || !isNotInterestedItem(target)) {
      return;
    }
    const cached = lastMenuContext && Date.now() - lastMenuContext.at < 10000 ? lastMenuContext : null;
    setTimeout(() => {
      const card = cached && cached.card;
      const channel = cached && cached.channel;
      if (channel && hasChannelData(channel)) {
        addBlockedChannel(channel, card);
      }
    }, 0);
    setTimeout(() => {
      const card = cached && cached.card;
      if (card && !hasChannelData(cached.channel)) {
        addBlockedChannel(extractChannel(card), card);
      }
    }, 180);
  }

  async function checkDynamicChannel() {
    if (!location.pathname.startsWith("/watch")) {
      return;
    }
    const owner = document.querySelector("ytd-video-owner-renderer");
    if (!owner) {
      return;
    }
    const subscribeButton = owner.querySelector("ytd-subscribe-button-renderer button, yt-subscribe-button-view-model button");
    if (!subscribeButton) {
      return;
    }
    const subscribed = Boolean(owner.querySelector("ytd-subscribe-button-renderer[subscribed], yt-subscribe-button-view-model button[aria-pressed='true']"));
    const unsubscribed = Boolean(owner.querySelector("ytd-subscribe-button-renderer:not([subscribed]), yt-subscribe-button-view-model button[aria-pressed='false']"));
    if (!subscribed && !unsubscribed) {
      return;
    }
    const channel = ownerChannel();
    if (!hasChannelData(channel)) {
      return;
    }
    const result = mergeChannel(channel, unsubscribed && !subscribed);
    if (result.changed) {
      state.channels = result.channels;
      updateSets();
      await browser.storage.local.set({ channels: state.channels });
    }
  }

  function showOverlay(text, spinning) {
    let element = document.getElementById("ff-sync-overlay");
    if (!element) {
      element = document.createElement("div");
      element.id = "ff-sync-overlay";
      element.className = "ff-sync-toast";
      (document.body || document.documentElement).appendChild(element);
    }
    element.replaceChildren();
    if (spinning) {
      const spinner = document.createElement("span");
      spinner.className = "ff-sync-spinner";
      spinner.setAttribute("aria-hidden", "true");
      element.appendChild(spinner);
    }
    element.appendChild(document.createTextNode(text));
    return element;
  }

  function removeOverlayLater() {
    const element = document.getElementById("ff-sync-overlay");
    if (element) {
      setTimeout(() => element.remove(), 4000);
    }
  }

  function progressText(count, startedAt, prefix) {
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    return prefix + " found " + count + " channels (" + seconds + "s)";
  }

  function createProgressWriter(phase, startedAt) {
    let lastWrite = 0;
    let timer = null;
    let latest = null;
    let lastQueued = null;
    let chain = Promise.resolve();

    function enqueue(value) {
      lastWrite = Date.now();
      latest = value;
      lastQueued = value;
      chain = chain.then(() => browser.storage.local.set({ syncProgress: value })).catch(() => {});
    }

    function report(count, round) {
      latest = { count, phase, startedAt, round };
      const delay = Math.max(0, 300 - (Date.now() - lastWrite));
      if (delay === 0) {
        enqueue(latest);
      } else if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          enqueue(latest);
        }, delay);
      }
    }

    report.finish = async function () {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (latest && latest !== lastQueued) {
        enqueue(latest);
      }
      await chain;
    };
    return report;
  }

  function channelCount(channels) {
    return Array.isArray(channels && channels.ids) ? channels.ids.length : 0;
  }

  async function waitForReady() {
    if (document.readyState === "loading") {
      await new Promise((resolve) => document.addEventListener("DOMContentLoaded", resolve, { once: true }));
    }
  }

  function overlayProgress(count, startedAt, phase) {
    const prefix = phase === "scroll" ? "FreshFeed: syncing subscriptions…" : "FreshFeed: syncing subscriptions…";
    showOverlay(progressText(count, startedAt, prefix), true);
  }

  function extractJsonObject(source, marker) {
    const markerIndex = source.indexOf(marker);
    if (markerIndex < 0) {
      return null;
    }
    const start = source.indexOf("{", markerIndex + marker.length);
    if (start < 0) {
      return null;
    }
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index];
      if (quoted) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === "\"") {
          quoted = false;
        }
        continue;
      }
      if (character === "\"") {
        quoted = true;
      } else if (character === "{") {
        depth += 1;
      } else if (character === "}" && --depth === 0) {
        try {
          return JSON.parse(source.slice(start, index + 1));
        } catch (error) {
          return null;
        }
      }
    }
    return null;
  }

  function htmlValue(html, key) {
    const match = html.match(new RegExp("\"" + key + "\"\\s*:\\s*\"([^\"]+)\""));
    return match ? match[1].replace(/\\u0026/g, "&") : "";
  }

  function channelTitle(value) {
    if (!value || typeof value !== "object") {
      return "";
    }
    if (typeof value.simpleText === "string") {
      return normName(value.simpleText);
    }
    if (Array.isArray(value.runs)) {
      return normName(value.runs.map((run) => run && run.text || "").join(""));
    }
    return "";
  }

  function collectSubscriptionData(node, result, depth) {
    if (!node || typeof node !== "object" || depth > 50) {
      return;
    }
    if (typeof node.channelId === "string" && /^UC[\w-]+$/i.test(node.channelId)) {
      const name = channelTitle(node.title);
      const endpoint = node.navigationEndpoint &&
        node.navigationEndpoint.browseEndpoint;
      const canonical = endpoint && endpoint.canonicalBaseUrl;
      const handle = typeof canonical === "string" && canonical.startsWith("/@")
        ? canonical.split("/")[1].toLowerCase()
        : "";
      const customUrl = typeof canonical === "string" ? normCustomUrl(canonical) : "";
      const channelId = node.channelId.toLowerCase();
      if (!result.channels.has(channelId)) {
        result.channels.set(channelId, { id: channelId, name, handle, customUrl });
      } else if (handle && !result.channels.get(channelId).handle) {
        result.channels.get(channelId).handle = handle;
      } else if (customUrl && !result.channels.get(channelId).customUrl) {
        result.channels.get(channelId).customUrl = customUrl;
      }
    }
    if (node.continuationCommand && typeof node.continuationCommand.token === "string") {
      result.tokens.add(node.continuationCommand.token);
    }
    Object.values(node).forEach((value) => collectSubscriptionData(value, result, depth + 1));
  }

  async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function authorizationHeader() {
    const item = document.cookie.split("; ").find((entry) => entry.startsWith("SAPISID=") || entry.startsWith("__Secure-3PAPISID="));
    if (!item) {
      return "";
    }
    const separator = item.indexOf("=");
    const value = decodeURIComponent(item.slice(separator + 1));
    const timestamp = Math.floor(Date.now() / 1000);
    const digest = await crypto.subtle.digest(
      "SHA-1",
      new TextEncoder().encode(timestamp + " " + value + " https://www.youtube.com")
    );
    const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    return "SAPISIDHASH " + timestamp + "_" + hash;
  }

  async function fetchSubscriptions(onProgress) {
    const response = await fetchWithTimeout("https://www.youtube.com/feed/channels", { credentials: "include" }, 10000);
    if (!response.ok) {
      throw new Error(response.status === 401 || response.status === 403 ? "authentication required" : "subscription page unavailable");
    }
    const html = await response.text();
    const initialData = extractJsonObject(html, "ytInitialData");
    if (!initialData) {
      throw new Error("subscription data unavailable");
    }
    const result = { channels: new Map(), tokens: new Set() };
    collectSubscriptionData(initialData, result, 0);
    const apiKey = htmlValue(html, "INNERTUBE_API_KEY");
    const clientVersion = htmlValue(html, "INNERTUBE_CLIENT_VERSION");
    if (!apiKey || !clientVersion) {
      throw new Error("YouTube API configuration unavailable");
    }
    const authorization = await authorizationHeader();
    const headers = {
      "Content-Type": "application/json",
      "X-Origin": "https://www.youtube.com",
      "X-Youtube-Client-Name": "1",
      "X-Youtube-Client-Version": clientVersion
    };
    if (authorization) {
      headers.Authorization = authorization;
    }
    let round = 0;
    let skippedPages = 0;
    onProgress({ count: result.channels.size, round, skippedPages });
    while (result.tokens.size && round < 200) {
      const token = result.tokens.values().next().value;
      result.tokens.delete(token);
      const continuationResponse = await fetchWithTimeout(
        "https://www.youtube.com/youtubei/v1/browse?key=" + encodeURIComponent(apiKey) + "&prettyPrint=false",
        {
          method: "POST",
          credentials: "include",
          headers,
          body: JSON.stringify({
            context: { client: { clientName: "WEB", clientVersion } },
            continuation: token
          })
        },
        10000
      );
      if (!continuationResponse.ok) {
        skippedPages += 1;
        onProgress({ count: result.channels.size, round, skippedPages });
        continue;
      }
      let pageData;
      try {
        pageData = await continuationResponse.json();
      } catch (error) {
        skippedPages += 1;
        onProgress({ count: result.channels.size, round, skippedPages });
        continue;
      }
      const page = { channels: new Map(), tokens: new Set() };
      collectSubscriptionData(pageData, page, 0);
      page.channels.forEach((channel, id) => {
        if (!result.channels.has(id) || (!result.channels.get(id).handle && channel.handle)) {
          result.channels.set(id, channel);
        }
      });
      page.tokens.forEach((pageToken) => result.tokens.add(pageToken));
      round += 1;
      onProgress({ count: result.channels.size, round, skippedPages });
    }
    const channels = { ids: [], handles: [], customUrls: [], names: [] };
    result.channels.forEach((channel) => {
      channels.ids.push(channel.id);
      if (channel.handle) {
        channels.handles.push(channel.handle);
      }
      if (channel.customUrl) {
        channels.customUrls.push(channel.customUrl);
      }
      if (channel.name) {
        channels.names.push(channel.name);
      }
    });
    if (!channels.ids.length) {
      throw new Error("no subscriptions found");
    }
    return {
    ...normalizeChannelState(channels),
    skippedPages
    };
  }

  async function runPrimarySync(userInitiated) {
    if (syncRunning) {
      return;
    }
    syncRunning = true;
    const startedAt = Date.now();
    const report = createProgressWriter("fetch", startedAt);
    await browser.storage.local.set({ syncProgress: { count: 0, phase: "fetch", startedAt } });
    try {
      const channels = await fetchSubscriptions(({ count, round, skippedPages }) => {
        report(count, round);
        if (userInitiated) {
          const suffix = skippedPages ? " (" + skippedPages + " unavailable pages skipped)" : "";
          overlayProgress(count, startedAt, "fetch" + suffix);
        }
      });
      await report.finish();
      const total = channelCount(channels);
      const syncedAt = Date.now();
      state.channels = channels;
      state.syncedAt = syncedAt;
      state.syncPending = false;
      state.syncFallback = false;
      state.syncProgress = null;
      updateSets();
      const warning = channels.skippedPages ? " (" + channels.skippedPages + " unavailable pages skipped)" : "";
      const result = "Synchronized " + total + " channels in " + Math.floor((syncedAt - startedAt) / 1000) + "s" + warning;
      await browser.storage.local.set({
        channels,
        syncedAt,
        initialSyncDone: true,
        syncPending: false,
        syncFallback: false,
        syncProgress: null,
        lastSyncResult: result
      });
      showOverlay("FreshFeed: ready, " + total + " channels", false);
      removeOverlayLater();
    } catch (error) {
      await report.finish();
      const message = (error && error.message) || "unknown error";
      await browser.storage.local.set({
        syncPending: false,
        syncProgress: null,
        syncFallback: true,
        lastSyncResult: "Sync failed: " + message + ". Trying page fallback…"
      });
      showOverlay("FreshFeed: trying page fallback…", true);
      if (location.pathname !== "/feed/channels") {
        location.href = "/feed/channels";
      } else {
        startFallbackSync();
      }
    } finally {
      syncRunning = false;
    }
  }

  function collectVisibleSubscriptions() {
    const channels = { ids: new Set(), handles: new Set(), customUrls: new Set(), names: new Set() };
    const channelRoots = document.querySelectorAll(
      "ytd-channel-renderer, ytd-grid-channel-renderer, ytd-channel-list-sub-menu-renderer"
    );
    const links = channelRoots.length
      ? Array.from(document.querySelectorAll("ytd-channel-renderer a[href], ytd-grid-channel-renderer a[href], ytd-channel-list-sub-menu-renderer a[href]"))
      : Array.from(document.querySelectorAll("main a[href], #primary a[href]"));
    links.forEach((link) => {
      const href = link.getAttribute("href") || "";
      if (href.startsWith("/@") || href.startsWith("/channel/")) {
        const parsed = parseChannelHref(link.getAttribute("href"));
        if (parsed.id) {
          channels.ids.add(parsed.id);
        }
        if (parsed.handle) {
          channels.handles.add(parsed.handle);
        }
        if (parsed.customUrl) {
          channels.customUrls.add(parsed.customUrl);
        }
        const name = normName(link.textContent || link.getAttribute("title") || link.getAttribute("aria-label"));
        if (name && name.length < 160) {
          channels.names.add(name);
        }
      }
    });
    document.querySelectorAll("[data-channel-id]").forEach((element) => {
      const id = element.getAttribute("data-channel-id");
      if (/^UC[\w-]+$/i.test(id || "")) {
        channels.ids.add(id);
      }
    });
    return normalizeChannelState({
      ids: Array.from(channels.ids),
      handles: Array.from(channels.handles),
      customUrls: Array.from(channels.customUrls),
      names: Array.from(channels.names)
    });
  }

  async function startFallbackSync() {
    if (fallbackRunning || location.pathname !== "/feed/channels" || !state.syncFallback) {
      return;
    }
    fallbackRunning = true;
    await waitForReady();
    const startedAt = Date.now();
    const report = createProgressWriter("scroll", startedAt);
    await browser.storage.local.set({ syncProgress: { count: 0, phase: "scroll", startedAt } });
    let unchanged = 0;
    let previousCount = -1;
    let sawSubscriptionContent = false;
    while (Date.now() - startedAt < 30000 && (unchanged < 3 || !sawSubscriptionContent)) {
      const bottom = document.documentElement.scrollHeight;
      window.scrollTo(0, bottom);
      if (document.scrollingElement) {
        document.scrollingElement.scrollTop = bottom;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
      const visible = collectVisibleSubscriptions();
      const count = channelCount(visible);
      sawSubscriptionContent = sawSubscriptionContent || count > 0;
      unchanged = count === previousCount ? unchanged + 1 : 0;
      previousCount = count;
      report(count, previousCount);
      overlayProgress(count, startedAt, "scroll");
    }
    const channels = collectVisibleSubscriptions();
    await report.finish();
    const total = channelCount(channels);
    const values = total > 0 ? channels : state.channels;
    state.channels = values;
    state.syncedAt = total > 0 ? Date.now() : state.syncedAt;
    state.syncPending = false;
    state.syncFallback = false;
    state.syncLock = null;
    state.syncProgress = null;
    const result = total > 0
      ? "Synchronized " + total + " channels (" + Math.floor((Date.now() - startedAt) / 1000) + "s)"
      : "FreshFeed: no subscriptions found. Make sure you are signed in to YouTube.";
    await browser.storage.local.set({
      channels: values,
      syncedAt: state.syncedAt,
      syncPending: false,
      syncFallback: false,
      syncLock: null,
      syncProgress: null,
      lastSyncResult: result
    });
    updateSets();
    showOverlay(total > 0 ? "FreshFeed: ready, " + total + " channels" : result, false);
    removeOverlayLater();
    fallbackRunning = false;
  }

  function readChannelFromRoot(root) {
    if (!root) {
      return { ids: new Set(), handles: new Set(), customUrls: new Set(), names: new Set() };
    }
    const result = { ids: new Set(), handles: new Set(), customUrls: new Set(), names: new Set() };
    const href = root.getAttribute("data-channel-id") || root.getAttribute("data-channel-handle") || root.querySelector("a[href]") && root.querySelector("a[href]").getAttribute("href") || "";
    const parsed = parseChannelHref(href);
    if (parsed.id) {
      result.ids.add(parsed.id);
    }
    if (parsed.handle) {
      result.handles.add(parsed.handle);
    }
    if (parsed.customUrl) {
      result.customUrls.add(parsed.customUrl);
    }
    const name = normName(root.querySelector("#text, yt-formatted-string, ytd-channel-name") && (root.querySelector("#text, yt-formatted-string, ytd-channel-name").textContent || root.querySelector("#text, yt-formatted-string, ytd-channel-name").getAttribute("title")));
    if (name) {
      result.names.add(name);
    }
    return result;
  }

  async function syncFromSubscribeButton(button) {
    if (!button) {
      return;
    }
    let channel = ownerChannel();
    const root = button.closest("ytd-channel-renderer, yt-channel-header-renderer, ytd-video-owner-renderer");
    if (root) {
      channel = readChannelFromRoot(root);
    }
    if (!hasChannelData(channel)) {
      const subscribeRoot = button.closest("ytd-subscribe-button-renderer, yt-subscribe-button-view-model");
      if (subscribeRoot) {
        channel = readChannelFromRoot(subscribeRoot);
      }
    }
    if (!hasChannelData(channel)) {
      return;
    }
    const buttonState = button.getAttribute("aria-pressed") === "true" || button.getAttribute("subscribed") === "true" || (button.closest("ytd-subscribe-button-renderer") && button.closest("ytd-subscribe-button-renderer").hasAttribute("subscribed"));
    const result = mergeChannel(channel, !buttonState);
    if (result.changed) {
      state.channels = result.channels;
      updateSets();
      await browser.storage.local.set({ channels: state.channels });
    }
  }

  async function maybeStartSync() {
    if (syncRunning || fallbackRunning || !state.syncPending) {
      return;
    }
    const candidate = { at: Date.now() };
    const current = state.syncLock;
    if (current && Date.now() - current.at < 30000) {
      return;
    }
    await browser.storage.local.set({ syncLock: candidate });
    const saved = await browser.storage.local.get("syncLock");
    if (!saved.syncLock || saved.syncLock.at !== candidate.at) {
      return;
    }
    state.syncLock = candidate;
    await runPrimarySync(true);
    await browser.storage.local.set({ syncLock: null });
    state.syncLock = null;
  }

  function applyStorage(changes) {
    if (changes.enabled) {
      state.enabled = changes.enabled.newValue !== false;
      if (state.enabled) {
        clearHiddenCards(true);
        updatePageMode();
      } else {
        disconnectHome();
        clearHiddenCards(false);
      }
    }
    if (changes.channels) {
      state.channels = normalizeChannelState(changes.channels.newValue);
      updateSets();
      if (homeActive) {
        clearHiddenCards(true);
        scheduleHomeScan();
      }
    }
    if (changes.blockedChannels) {
      state.blockedChannels = normalizeChannelState(changes.blockedChannels.newValue);
      updateSets();
      if (homeActive) {
        clearHiddenCards(true);
        scheduleHomeScan();
      }
    }
    const settingKeys = Object.keys(DEFAULT_SETTINGS);
    if (settingKeys.some((key) => changes[key])) {
      state.settings = normalizeSettings({
        ...state.settings,
        ...Object.fromEntries(settingKeys.map((key) => [key, changes[key] ? changes[key].newValue : state.settings[key]]))
      });
      updateSets();
      clearHiddenCards(true);
      updatePageMode();
    }
    if (changes.syncPending) {
      state.syncPending = Boolean(changes.syncPending.newValue);
      if (state.syncPending) {
        maybeStartSync();
      }
    }
    if (changes.syncFallback) {
      state.syncFallback = Boolean(changes.syncFallback.newValue);
      if (state.syncFallback && location.pathname === "/feed/channels") {
        startFallbackSync();
      }
    }
    if (changes.syncLock) {
      state.syncLock = changes.syncLock.newValue || null;
    }
    if (changes.syncProgress) {
      state.syncProgress = changes.syncProgress.newValue || null;
    }
    if (changes.syncedAt) {
      state.syncedAt = changes.syncedAt.newValue || null;
    }
  }

  async function init() {
    const saved = await browser.storage.local.get([
      "enabled",
      "channels",
      "blockedChannels",
      ...Object.keys(DEFAULT_SETTINGS),
      "syncedAt",
      "syncPending",
      "syncLock",
      "syncProgress",
      "syncFallback",
      "lastSyncResult",
      "initialSyncDone"
    ]);
    state.enabled = true;
    state.channels = normalizeChannelState(saved.channels);
    state.blockedChannels = normalizeChannelState(saved.blockedChannels);
    state.settings = normalizeSettings(saved);
    state.syncedAt = saved.syncedAt || null;
    state.syncPending = Boolean(saved.syncPending);
    state.syncLock = saved.syncLock || null;
    state.syncProgress = saved.syncProgress || null;
    state.syncFallback = Boolean(saved.syncFallback);
    installPageFilter();
    if (saved.initialSyncDone !== true && !saved.syncPending && !saved.syncFallback) {
      await browser.storage.local.set({ syncPending: true, syncPendingAt: Date.now() });
      state.syncPending = true;
    }
    updateSets();
    browser.storage.onChanged.addListener(applyStorage);
    window.addEventListener("yt-navigate-finish", updatePageMode);
    window.addEventListener("popstate", () => setTimeout(updatePageMode, 0));
    document.addEventListener("click", (event) => {
      const button = event.target && event.target.closest && event.target.closest("button");
      if (!button) {
        return;
      }
      const subscribeTarget = button.closest("ytd-subscribe-button-renderer, yt-subscribe-button-view-model") || button.closest("ytd-channel-renderer") || button.closest("yt-channel-header-renderer");
      if (!subscribeTarget) {
        return;
      }
      setTimeout(() => syncFromSubscribeButton(button), 120);
    }, true);
    document.addEventListener("click", observeNotInterestedAction, true);
    updatePageMode();
    if (state.syncFallback && location.pathname === "/feed/channels") {
      startFallbackSync();
    } else if (state.syncPending) {
      maybeStartSync();
    }
  }

  init();
}());
