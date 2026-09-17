(function () {
  "use strict";

  const CARD_SELECTOR = "ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer, ytd-reel-item-renderer";
  const CHANNEL_LINK_SELECTOR = 'a[href^="/@"], a[href^="/channel/"]';
  const DEFAULT_CHANNELS = { ids: [], handles: [], names: [] };
  let state = {
    enabled: true,
    channels: DEFAULT_CHANNELS,
    syncedAt: null,
    syncPending: false,
    syncLock: null,
    syncProgress: null,
    syncFallback: false
  };
  let ids = new Set();
  let handles = new Set();
  let names = new Set();
  let homeObserver = null;
  let homeTimer = null;
  let homeActive = false;
  let syncRunning = false;
  let fallbackRunning = false;
  let dynamicTimer = null;

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
      return { id: parts[1] };
    }
    if (parts[0].startsWith("@")) {
      return { handle: parts[0].toLowerCase() };
    }
    return {};
  }

  function normalizeChannelState(channels) {
    return {
      ids: Array.from(new Set(Array.isArray(channels && channels.ids) ? channels.ids.filter((item) => /^UC[\w-]+$/i.test(item)) : [])),
      handles: Array.from(new Set(Array.isArray(channels && channels.handles) ? channels.handles.map((item) => String(item).toLowerCase()).filter((item) => /^@[^/]+$/.test(item)) : [])),
      names: Array.from(new Set(Array.isArray(channels && channels.names) ? channels.names.map(normName).filter(Boolean) : []))
    };
  }

  function updateSets() {
    state.channels = normalizeChannelState(state.channels);
    ids = new Set(state.channels.ids);
    handles = new Set(state.channels.handles);
    names = new Set(state.channels.names);
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
      result.ids.add(value.browseId);
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
    const result = { ids: new Set(), handles: new Set(), names: new Set() };
    card.querySelectorAll(CHANNEL_LINK_SELECTOR).forEach((link) => {
      const parsed = parseChannelHref(link.getAttribute("href"));
      if (parsed.id) {
        result.ids.add(parsed.id);
      }
      if (parsed.handle) {
        result.handles.add(parsed.handle);
      }
    });
    const nameSelectors = [
      "ytd-channel-name #text",
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
    if (!result.ids.size && !result.handles.size) {
      try {
        walkEmbeddedData(card.wrappedJSObject && card.wrappedJSObject.data, 0, new Set(), result);
      } catch (error) {
        // Доступ к данным обёртки может быть запрещён Firefox.
      }
    }
    return result;
  }

  function hasChannelData(channel) {
    return channel.ids.size > 0 || channel.handles.size > 0 || channel.names.size > 0;
  }

  function isSubscribed(channel) {
    return Array.from(channel.ids).some((id) => ids.has(id)) ||
      Array.from(channel.handles).some((handle) => handles.has(handle)) ||
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
    if (state.enabled && isSubscribed(channel)) {
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
    if (location.pathname !== "/" || !state.enabled) {
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
    if (location.pathname === "/") {
      connectHome();
    } else {
      disconnectHome();
    }
    if (location.pathname === "/feed/channels" && state.syncFallback) {
      startFallbackSync();
    }
    if (location.pathname.startsWith("/watch")) {
      scheduleDynamicCheck();
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
      return { ids: new Set(), handles: new Set(), names: new Set() };
    }
    const result = { ids: new Set(), handles: new Set(), names: new Set() };
    owner.querySelectorAll("a[href]").forEach((link) => {
      const parsed = parseChannelHref(link.getAttribute("href"));
      if (parsed.id) {
        result.ids.add(parsed.id);
      }
      if (parsed.handle) {
        result.handles.add(parsed.handle);
      }
    });
    const name = normName(owner.querySelector("ytd-channel-name #text") && owner.querySelector("ytd-channel-name #text").textContent);
    if (name) {
      result.names.add(name);
    }
    return result;
  }

  function mergeChannel(channel, remove) {
    const next = {
      ids: new Set(state.channels.ids),
      handles: new Set(state.channels.handles),
      names: new Set(state.channels.names)
    };
    const operation = remove ? "delete" : "add";
    channel.ids.forEach((value) => next.ids[operation](value));
    channel.handles.forEach((value) => next.handles[operation](value));
    channel.names.forEach((value) => next.names[operation](value));
    const channels = {
      ids: Array.from(next.ids),
      handles: Array.from(next.handles),
      names: Array.from(next.names)
    };
    return { changed: JSON.stringify(state.channels) !== JSON.stringify(channels), channels };
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
    return prefix + " найдено " + count + " каналов (" + seconds + " с)";
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
    return Math.max(channels.ids.length, channels.handles.length, channels.names.length);
  }

  async function waitForReady() {
    if (document.readyState === "loading") {
      await new Promise((resolve) => document.addEventListener("DOMContentLoaded", resolve, { once: true }));
    }
  }

  function overlayProgress(count, startedAt, phase) {
    const prefix = phase === "scroll" ? "FreshFeed: синхронизация подписок…" : "FreshFeed: синхронизация подписок…";
    showOverlay(progressText(count, startedAt, prefix), true);
  }

  async function runPrimarySync(userInitiated) {
    if (!userInitiated) {
      return;
    }
    await browser.storage.local.set({
      syncFallback: true,
      syncLock: null,
      syncProgress: null,
      lastSyncResult: "Открываю страницу подписок для ручной синхронизации…"
    });
    if (location.pathname !== "/feed/channels") {
      location.href = "/feed/channels";
    } else {
      startFallbackSync();
    }
  }

  function collectVisibleSubscriptions() {
    const channels = { ids: new Set(), handles: new Set(), names: new Set() };
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
    while (Date.now() - startedAt < 90000 && (unchanged < 5 || !sawSubscriptionContent)) {
      const bottom = document.documentElement.scrollHeight;
      window.scrollTo(0, bottom);
      if (document.scrollingElement) {
        document.scrollingElement.scrollTop = bottom;
      }
      await new Promise((resolve) => setTimeout(resolve, 800));
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
      ? "Синхронизировано: " + total + " каналов (" + Math.floor((Date.now() - startedAt) / 1000) + " с)"
      : "FreshFeed: не удалось найти подписки. Проверьте, что вы вошли в YouTube.";
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
    showOverlay(total > 0 ? "FreshFeed: готово, " + total + " каналов" : result, false);
    removeOverlayLater();
    fallbackRunning = false;
  }

  function readChannelFromRoot(root) {
    if (!root) {
      return { ids: new Set(), handles: new Set(), names: new Set() };
    }
    const result = { ids: new Set(), handles: new Set(), names: new Set() };
    const href = root.getAttribute("data-channel-id") || root.getAttribute("data-channel-handle") || root.querySelector("a[href]") && root.querySelector("a[href]").getAttribute("href") || "";
    const parsed = parseChannelHref(href);
    if (parsed.id) {
      result.ids.add(parsed.id);
    }
    if (parsed.handle) {
      result.handles.add(parsed.handle);
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
    if (syncRunning || fallbackRunning || state.syncFallback || !state.syncPending) {
      return;
    }
    syncRunning = true;
    await runPrimarySync(true);
    syncRunning = false;
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
      "syncedAt",
      "syncPending",
      "syncLock",
      "syncProgress",
      "syncFallback",
      "lastSyncResult"
    ]);
    state.enabled = saved.enabled !== false;
    state.channels = normalizeChannelState(saved.channels);
    state.syncedAt = saved.syncedAt || null;
    state.syncPending = Boolean(saved.syncPending);
    state.syncLock = saved.syncLock || null;
    state.syncProgress = saved.syncProgress || null;
    state.syncFallback = Boolean(saved.syncFallback);
    if (saved.lastSyncResult === "Ошибка синхронизации: fetch") {
      await browser.storage.local.set({ lastSyncResult: null });
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
    updatePageMode();
    if (state.syncFallback && location.pathname === "/feed/channels") {
      startFallbackSync();
    } else if (state.syncPending) {
      maybeStartSync();
    }
  }

  init();
}());
