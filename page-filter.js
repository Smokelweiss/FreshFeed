(function () {
  "use strict";

  if (window.__freshFeedPageFilterInstalled) {
    return;
  }
  window.__freshFeedPageFilterInstalled = true;

  let index = { ids: new Set(), handles: new Set(), customUrls: new Set(), names: new Set() };
  let blockedIndex = { ids: new Set(), handles: new Set(), customUrls: new Set(), names: new Set() };
  let settings = {
    hideSubscribedChannels: true,
    hideNotInterestedChannels: true,
    filterRecommendations: true
  };

  function normalize(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function normalizeHandle(value) {
    const raw = normalize(value);
    return raw.startsWith("@") ? raw : raw ? "@" + raw : "";
  }

  function normalizeCustomUrl(value) {
    let raw = String(value || "").trim().toLowerCase();
    if (!raw) return "";
    raw = raw.replace(/^https?:\/\/[^/]+/i, "").split(/[?#]/)[0].replace(/^\/|\/$/g, "");
    return /^(?:c|user)\/[^/]+$/.test(raw) ? raw : "";
  }

  function matchesIndex(node, candidate) {
    if (!node || typeof node !== "object") return false;
    const ids = new Set();
    const handles = new Set();
    const customUrls = new Set();
    const names = new Set();
    const seen = new Set();
    const visit = (value, depth) => {
      if (!value || typeof value !== "object" || depth > 7 || seen.has(value)) return;
      seen.add(value);
      if (typeof value.browseId === "string" && /^UC[\w-]+$/i.test(value.browseId)) ids.add(value.browseId);
      if (typeof value.channelId === "string" && /^UC[\w-]+$/i.test(value.channelId)) ids.add(value.channelId);
      if (typeof value.canonicalBaseUrl === "string") {
        const url = value.canonicalBaseUrl;
        if (url.startsWith("/@")) handles.add(normalizeHandle(url.split("/")[1]));
        const custom = normalizeCustomUrl(url);
        if (custom) customUrls.add(custom);
      }
      if (typeof value.navigationEndpoint?.browseEndpoint?.browseId === "string") {
        ids.add(value.navigationEndpoint.browseEndpoint.browseId);
      }
      for (const key of ["title", "name", "authorText", "shortBylineText", "longBylineText"]) {
        const candidate = value[key];
        if (typeof candidate === "string") names.add(normalize(candidate));
        if (candidate?.simpleText) names.add(normalize(candidate.simpleText));
        if (Array.isArray(candidate?.runs)) names.add(normalize(candidate.runs.map((run) => run?.text || "").join("")));
      }
      Object.values(value).forEach((child) => visit(child, depth + 1));
    };
    visit(node, 0);
    return Array.from(ids).some((value) => candidate.ids.has(value)) ||
      Array.from(handles).some((value) => candidate.handles.has(value)) ||
      Array.from(customUrls).some((value) => candidate.customUrls.has(value)) ||
      Array.from(names).some((value) => candidate.names.has(value));
  }

  function channelMatches(node) {
    if (location.pathname === "/" && !settings.filterRecommendations) return false;
    return (settings.hideSubscribedChannels && matchesIndex(node, index)) ||
      (settings.hideNotInterestedChannels && matchesIndex(node, blockedIndex));
  }

  const rendererKeys = new Set([
    "videoRenderer",
    "richItemRenderer",
    "gridVideoRenderer",
    "compactVideoRenderer",
    "videoWithContextRenderer",
    "reelItemRenderer",
    "shortsLockupViewModel",
    "shortsLockupViewModelV2",
    "lockupViewModel"
  ]);

  function filterNode(node, depth) {
    if (!node || typeof node !== "object" || depth > 35) return;
    for (const [key, value] of Object.entries(node)) {
      const isShort = key === "reelItemRenderer" || key === "shortsLockupViewModel" || key === "shortsLockupViewModelV2";
      if (rendererKeys.has(key) && value && typeof value === "object" && (!isShort || settings.hideShorts) && channelMatches(value)) {
        delete node[key];
        continue;
      }
      if (value && typeof value === "object") filterNode(value, depth + 1);
    }
  }

  function installConfig(event) {
    const data = event.data;
    if (!data || data.source !== "freshfeed-content" || data.type !== "index") return;
    index = {
      ids: new Set(Array.isArray(data.index?.ids) ? data.index.ids : []),
      handles: new Set(Array.isArray(data.index?.handles) ? data.index.handles : []),
      customUrls: new Set(Array.isArray(data.index?.customUrls) ? data.index.customUrls : []),
      names: new Set(Array.isArray(data.index?.names) ? data.index.names : [])
    };
    blockedIndex = {
      ids: new Set(Array.isArray(data.blockedIndex?.ids) ? data.blockedIndex.ids : []),
      handles: new Set(Array.isArray(data.blockedIndex?.handles) ? data.blockedIndex.handles : []),
      customUrls: new Set(Array.isArray(data.blockedIndex?.customUrls) ? data.blockedIndex.customUrls : []),
      names: new Set(Array.isArray(data.blockedIndex?.names) ? data.blockedIndex.names : [])
    };
    settings = { ...settings, ...(data.settings || {}) };
  }

  window.addEventListener("message", installConfig, true);
  window.postMessage({ source: "freshfeed-page-filter", type: "ready" }, "*");
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    if (
      !index.ids.size && !index.handles.size && !index.customUrls.size && !index.names.size &&
      !blockedIndex.ids.size && !blockedIndex.handles.size && !blockedIndex.customUrls.size && !blockedIndex.names.size
    ) return response;
    const requestUrl = typeof response.url === "string" ? response.url : String(args[0] || "");
    if (!/\/youtubei\/v1\/(?:browse|next|player)(?:\?|$)/.test(requestUrl)) return response;
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("json")) return response;
    const clone = response.clone();
    try {
      const data = await clone.json();
      filterNode(data, 0);
      return new Response(JSON.stringify(data), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
    } catch {
      return response;
    }
  };
}());
