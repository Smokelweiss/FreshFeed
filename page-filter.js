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
    hidePlayables: false,
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
    if (matchesIndex(node, blockedIndex)) return true;
    return settings.hideSubscribedChannels && matchesIndex(node, index);
  }

  function textOf(node) {
    const values = [];
    const seen = new Set();
    const visit = (value, depth) => {
      if (!value || typeof value !== "object" || depth > 8 || seen.has(value)) return;
      seen.add(value);
      for (const key of ["title", "simpleText", "text", "publishedTimeText", "lengthText", "viewCountText", "badges"]) {
        const candidate = value[key];
        if (typeof candidate === "string") values.push(candidate);
        if (candidate?.simpleText) values.push(candidate.simpleText);
        if (Array.isArray(candidate?.runs)) values.push(candidate.runs.map((run) => run?.text || "").join(""));
      }
      Object.values(value).forEach((child) => visit(child, depth + 1));
    };
    visit(node, 0);
    return values.join(" ").toLowerCase();
  }

  function durationSeconds(node) {
    const raw = node?.lengthText?.simpleText || node?.lengthText?.runs?.map((run) => run?.text || "").join("") ||
      node?.thumbnailOverlays?.find?.((item) => item?.thumbnailOverlayTimeStatusRenderer)?.thumbnailOverlayTimeStatusRenderer?.text?.simpleText;
    const parts = String(raw || "").trim().split(":").map(Number);
    if (!parts.length || parts.some((part) => !Number.isFinite(part))) return null;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return null;
  }

  function ageDays(node) {
    const text = textOf(node);
    const match = text.match(/(\d+)\s+(day|week|month|year)s?\s+ago/);
    if (!match) return null;
    const multipliers = { day: 1, week: 7, month: 30, year: 365 };
    return Number(match[1]) * multipliers[match[2]];
  }

  function dateUnitDays(unit) {
    return { days: 1, weeks: 7, months: 30, years: 365 }[unit] || 1;
  }

  function durationUnitSeconds(unit) {
    return { seconds: 1, minutes: 60, hours: 3600, days: 86400 }[unit] || 60;
  }

  function dateFilterMatches(daysOld) {
    const unitDays = dateUnitDays(settings.uploadDateUnit);
    const value = Number(settings.uploadDateValue) * unitDays;
    if (settings.uploadDateMode === "between") {
      const min = Number(settings.uploadDateMin) * unitDays;
      const max = Number(settings.uploadDateMax) * unitDays;
      return daysOld < Math.min(min, max) || daysOld > Math.max(min, max);
    }
    return daysOld > value;
  }

  function durationFilterMatches(seconds) {
    const unitSeconds = durationUnitSeconds(settings.durationUnit);
    const value = Number(settings.durationValue) * unitSeconds;
    if (settings.durationMode === "between") {
      const min = Number(settings.durationMin) * unitSeconds;
      const max = Number(settings.durationMax) * unitSeconds;
      return seconds < Math.min(min, max) || seconds > Math.max(min, max);
    }
    return seconds > value;
  }

  function contentMatches(node, rendererKey) {
    const text = textOf(node);
    if (settings.hidePlayables && (rendererKey.includes("playable") || text.includes("playables"))) return true;
    if (settings.hideMembersOnly && (text.includes("members-only") || text.includes("members only") || text.includes("members"))) return true;
    if (settings.hideMixRadio && (rendererKey.includes("radio") || rendererKey.includes("mix") || rendererKey.includes("playlist") && text.includes("mix"))) return true;
    const age = ageDays(node);
    if (settings.filterUploadDate && age !== null && dateFilterMatches(age)) return true;
    const duration = durationSeconds(node);
    if (settings.filterDuration && duration !== null && durationFilterMatches(duration)) return true;
    return false;
  }

  const rendererKeys = new Set([
    "videoRenderer",
    "richItemRenderer",
    "gridVideoRenderer",
    "compactVideoRenderer",
    "videoWithContextRenderer",
    "radioRenderer",
    "compactRadioRenderer",
    "playlistRenderer",
    "compactPlaylistRenderer",
    "richShelfRenderer",
    "richSectionRenderer",
    "playableRenderer",
    "compactMovieRenderer",
    "movieRenderer",
    "reelItemRenderer",
    "shortsLockupViewModel",
    "shortsLockupViewModelV2",
    "lockupViewModel"
  ]);

  function filterNode(node, depth) {
    if (!node || typeof node !== "object" || depth > 35) return;
    for (const [key, value] of Object.entries(node)) {
      const isShort = key === "reelItemRenderer" || key === "shortsLockupViewModel" || key === "shortsLockupViewModelV2";
      if (
        rendererKeys.has(key) &&
        value &&
        typeof value === "object" &&
        (!isShort || settings.hideShorts) &&
        (channelMatches(value) || contentMatches(value, key))
      ) {
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
