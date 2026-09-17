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
    syncFallback: false,
    lastAutoSyncAttempt: null
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

  function cookieValue(name) {
    const item = document.cookie.split("; ").find((entry) => entry.startsWith(name + "="));
    return item ? decodeURIComponent(item.slice(name.length + 1)) : "";
  }

  async function authorizationHeader() {
    const sapisid = cookieValue("SAPISID") || cookieValue("__Secure-3PAPISID");
    if (!sapisid) {
      return "";
    }
    const timestamp = Math.floor(Date.now() / 1000);
    const input = timestamp + " " + sapisid + " https://www.youtube.com";
    const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(input));
    const hash = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
    return "SAPISIDHASH " + timestamp + "_" + hash;
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

  function collect(node, out) {
    const stack = [{ value: node, depth: 0 }];
    while (stack.length) {
      const current = stack.pop();
      const value = current.value;
      if (!value || typeof value !== "object" || current.depth > 40) {
        continue;
      }
      if (typeof value.channelId === "string" && value.channelId.startsWith("UC")) {
        const name = channelTitle(value.title);
        if (name) {
          let handle = "";
          const canonical = value.navigationEndpoint &&
            value.navigationEndpoint.browseEndpoint &&
            value.navigationEndpoint.browseEndpoint.canonicalBaseUrl;
          if (typeof canonical === "string" && canonical.startsWith("/@")) {
            handle = canonical.split("/")[1].toLowerCase();
          }
          if (!out.channels.has(value.channelId)) {
            out.channels.set(value.channelId, { id: value.channelId, name, handle });
          } else if (handle && !out.channels.get(value.channelId).handle) {
            out.channels.get(value.channelId).handle = handle;
          }
        }
      }
      if (value.continuationCommand && typeof value.continuationCommand.token === "string") {
        out.tokens.push(value.continuationCommand.token);
      }
      const entries = Array.isArray(value) ? value.entries() : Object.entries(value);
      for (const entry of entries) {
        stack.push({ value: entry[1], depth: current.depth + 1 });
      }
    }
  }

  function logSyncFailure(label, error) {
    const message = (error && error.message) || String(error || "unknown");
    console.warn("[FreshFeed] " + label + ":", message);
    if (browser && browser.storage && browser.storage.local) {
      browser.storage.local.set({ lastSyncResult: "Ошибка синхронизации: " + message }).catch(() => {});
    }
  }

  async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || 15000);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  function parseInitialData(html) {
    const candidates = [
      /var ytInitialData\s*=\s*(\{.*?\});\s*<\/script>/s,
      /ytInitialData"\]\s*=\s*(\{.*?\});\s*<\/script>/s,
      /\["ytInitialData"\]\s*=\s*(\{.*?\});\s*<\/script>/s,
      /ytInitialData\s*=\s*(\{.*?\});\s*<\/script>/s,
      /var ytInitialData\s*=\s*(\{.*?\});/s
    ];
    for (const pattern of candidates) {
      const match = html.match(pattern);
      if (match) {
        try {
          return JSON.parse(match[1]);
        } catch (error) {
          throw new Error("not-logged-in");
        }
      }
    }
    throw new Error("not-logged-in");
  }

  function htmlValue(html, key) {
    const match = html.match(new RegExp("\"" + key + "\":\"([^\"]+)\""));
    return match ? match[1] : "";
  }

  async function fetchSubscriptions(onProgress) {
    const response = await fetchWithTimeout("https://www.youtube.com/feed/channels", { credentials: "include" }, 20000);
    if (!response.ok) {
      throw new Error(response.status === 401 || response.status === 403 ? "auth" : "fetch");
    }
    const html = await response.text();
    let data;
    try {
      data = parseInitialData(html);
    } catch (error) {
      if (error && error.message === "not-logged-in") {
        throw new Error("not-logged-in");
      }
      throw error;
    }
    const out = { channels: new Map(), tokens: [] };
    collect(data, out);
    if (!html.includes("channelRenderer") && !out.tokens.length) {
      throw new Error("not-logged-in");
    }
    const apiKey = htmlValue(html, "INNERTUBE_API_KEY");
    const clientVersion = htmlValue(html, "INNERTUBE_CLIENT_VERSION");
    const sessionIndex = htmlValue(html, "SESSION_INDEX") || "0";
    const hl = htmlValue(html, "HL") || "ru";
    const gl = htmlValue(html, "GL") || "RU";
    const seenTokens = new Set();
    let round = 0;
    onProgress({ count: out.channels.size, round });
    while (out.tokens.length && round < 200) {
      const token = out.tokens[out.tokens.length - 1];
      out.tokens.length = 0;
      if (!token || seenTokens.has(token)) {
        break;
      }
      seenTokens.add(token);
      const headers = {
        "Content-Type": "application/json",
        "X-Origin": "https://www.youtube.com",
        "X-Youtube-Client-Name": "1",
        "X-Youtube-Client-Version": clientVersion,
        "X-Goog-AuthUser": sessionIndex
      };
      const authorization = await authorizationHeader();
      if (authorization) {
        headers.Authorization = authorization;
      }
      const continuationResponse = await fetchWithTimeout("https://www.youtube.com/youtubei/v1/browse?key=" + encodeURIComponent(apiKey) + "&prettyPrint=false", {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify({
          context: { client: { clientName: "WEB", clientVersion, hl, gl } },
          continuation: token
        })
      }, 20000);
      if (continuationResponse.status === 401 || continuationResponse.status === 403) {
        throw new Error("auth");
      }
      if (!continuationResponse.ok) {
        throw new Error("fetch");
      }
      const continuationData = await continuationResponse.json();
      const page = { channels: new Map(), tokens: [] };
      collect(continuationData, page);
      page.channels.forEach((channel, id) => {
        if (!out.channels.has(id)) {
          out.channels.set(id, channel);
        } else if (channel.handle && !out.channels.get(id).handle) {
          out.channels.get(id).handle = channel.handle;
        }
      });
      out.tokens.push(...page.tokens);
      round += 1;
      onProgress({ count: out.channels.size, round });
    }
    const channels = { ids: [], handles: [], names: [] };
    out.channels.forEach((channel) => {
      channels.ids.push(channel.id);
      if (channel.handle) {
        channels.handles.push(channel.handle);
      }
      channels.names.push(channel.name);
    });
    return normalizeChannelState(channels);
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
    const startedAt = Date.now();
    const report = createProgressWriter("fetch", startedAt);
    await browser.storage.local.set({ syncProgress: { count: 0, phase: "fetch", startedAt } });
    try {
      const channels = await fetchSubscriptions(({ count, round }) => {
        report(count, round);
        if (userInitiated) {
          overlayProgress(count, startedAt, "fetch");
        }
      });
      await report.finish();
      const total = channelCount(channels);
      state.channels = channels;
      state.syncedAt = Date.now();
      state.syncPending = false;
      state.syncFallback = false;
      state.syncLock = null;
      state.syncProgress = null;
      const result = "Синхронизировано: " + total + " каналов (" + Math.floor((Date.now() - startedAt) / 1000) + " с)";
      await browser.storage.local.set({
        channels,
        syncedAt: state.syncedAt,
        syncPending: false,
        syncLock: null,
        syncProgress: null,
        syncFallback: false,
        lastSyncResult: result
      });
      updateSets();
      if (userInitiated) {
        showOverlay("FreshFeed: готово, " + total + " каналов", false);
        removeOverlayLater();
      }
    } catch (error) {
      await report.finish();
      const message = (error && error.message) || String(error || "unknown");
      logSyncFailure("primary sync", error);
      await browser.storage.local.set({
        syncLock: null,
        syncProgress: null,
        syncFallback: userInitiated,
        lastSyncResult: "Ошибка синхронизации: " + message
      });
      if (userInitiated) {
        showOverlay("FreshFeed: не удалось получить подписки автоматически — открываю страницу подписок…", true);
        location.href = "/feed/channels";
      }
    }
  }

  function collectVisibleSubscriptions() {
    const channels = { ids: new Set(), handles: new Set(), names: new Set() };
    document.querySelectorAll("ytd-channel-renderer").forEach((card) => {
      card.querySelectorAll("a[href]").forEach((link) => {
        const parsed = parseChannelHref(link.getAttribute("href"));
        if (parsed.id) {
          channels.ids.add(parsed.id);
        }
        if (parsed.handle) {
          channels.handles.add(parsed.handle);
        }
      });
      const nameElement = card.querySelector("ytd-channel-name #text, #channel-title");
      const name = normName(nameElement && nameElement.textContent);
      if (name) {
        channels.names.add(name);
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
    while (Date.now() - startedAt < 60000 && unchanged < 3) {
      const bottom = document.documentElement.scrollHeight;
      window.scrollTo(0, bottom);
      if (document.scrollingElement) {
        document.scrollingElement.scrollTop = bottom;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
      const count = document.querySelectorAll("ytd-channel-renderer").length;
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
    const result = total > 0 ? "Синхронизировано: " + total + " каналов (" + Math.floor((Date.now() - startedAt) / 1000) + " с)" : "FreshFeed: подписки не найдены";
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

  function lockIsActive(lock) {
    return Boolean(lock && typeof lock.at === "number" && Date.now() - lock.at < 120000);
  }

  async function maybeStartSync() {
    if (syncRunning || fallbackRunning || state.syncFallback) {
      return;
    }
    syncRunning = true;
    const now = Date.now();
    const forced = state.syncPending === true;
    const stale = !state.syncedAt || now - state.syncedAt >= 86400000;
    const attemptedRecently = state.lastAutoSyncAttempt && now - state.lastAutoSyncAttempt < 1800000;
    if (!forced && (!stale || attemptedRecently)) {
      syncRunning = false;
      return;
    }
    if (lockIsActive(state.syncLock)) {
      syncRunning = false;
      return;
    }
    const candidate = { at: now };
    const staleProgress = state.syncProgress &&
      typeof state.syncProgress.startedAt === "number" &&
      now - state.syncProgress.startedAt > 180000;
    const lockState = { syncLock: candidate, lastAutoSyncAttempt: now };
    if (staleProgress) {
      lockState.syncProgress = null;
    }
    await browser.storage.local.set(lockState);
    const saved = await browser.storage.local.get(["syncLock", "syncPending"]);
    if (!saved.syncLock || saved.syncLock.at !== candidate.at) {
      syncRunning = false;
      return;
    }
    await runPrimarySync(forced || saved.syncPending === true);
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
    if (changes.lastAutoSyncAttempt) {
      state.lastAutoSyncAttempt = changes.lastAutoSyncAttempt.newValue || null;
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
      "lastAutoSyncAttempt",
      "lastSyncResult"
    ]);
    state.enabled = saved.enabled !== false;
    state.channels = normalizeChannelState(saved.channels);
    state.syncedAt = saved.syncedAt || null;
    state.syncPending = Boolean(saved.syncPending);
    state.syncLock = saved.syncLock || null;
    state.syncProgress = saved.syncProgress || null;
    state.syncFallback = Boolean(saved.syncFallback);
    state.lastAutoSyncAttempt = saved.lastAutoSyncAttempt || null;
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
    } else {
      maybeStartSync();
    }
  }

  init();
}());
