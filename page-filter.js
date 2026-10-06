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
    hideBlacklisted: true,
    hideShorts: true,
    hidePlayables: true,
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
    endlessFeed: false,
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
      if (typeof value.browseId === "string" && /^UC[\w-]+$/i.test(value.browseId)) ids.add(value.browseId.toLowerCase());
      if (typeof value.channelId === "string" && /^UC[\w-]+$/i.test(value.channelId)) ids.add(value.channelId.toLowerCase());
      if (typeof value.canonicalBaseUrl === "string") {
        const url = value.canonicalBaseUrl;
        if (url.startsWith("/@")) handles.add(normalizeHandle(url.split("/")[1]));
        const custom = normalizeCustomUrl(url);
        if (custom) customUrls.add(custom);
      }
      if (typeof value.navigationEndpoint?.browseEndpoint?.browseId === "string") {
        ids.add(value.navigationEndpoint.browseEndpoint.browseId.toLowerCase());
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
    if (settings.hideBlacklisted && matchesIndex(node, blockedIndex)) return true;
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

  // A Short is governed by "Hide Shorts" alone. The content filters below are
  // meaningless for Shorts and previously deleted them when an unrelated filter
  // (notably members-only) happened to match.
  function shortMatches() {
    return settings.hideShorts === true;
  }

  function contentMatches(node, rendererKey) {
    const text = textOf(node);
    if (settings.hidePlayables && (rendererKey.includes("playable") || /(^|\s)playables(\s|$)/.test(text))) return true;
    if (settings.hideMembersOnly && /members[- ]only|\u0442\u043e\u043b\u044c\u043a\u043e \u0434\u043b\u044f \u0441\u043f\u043e\u043d\u0441\u043e\u0440\u043e\u0432/.test(text)) return true;
    // Mix/Radio is a playlist renderer or an explicit RD radio link, never just
    // a video whose title or description happens to contain "mix".
    if (settings.hideMixRadio && (rendererKey === "radioRenderer" || rendererKey === "compactRadioRenderer" || hasRadioEndpoint(node))) return true;
    const age = ageDays(node);
    if (settings.filterUploadDate && age !== null && dateFilterMatches(age)) return true;
    const duration = durationSeconds(node);
    if (settings.filterDuration && duration !== null && durationFilterMatches(duration)) return true;
    return false;
  }

  function hasRadioEndpoint(node) {
    const queue = [node];
    const seen = new Set();
    while (queue.length && seen.size < 80) {
      const child = queue.shift();
      if (!child || typeof child !== "object" || seen.has(child)) continue;
      seen.add(child);
      for (const [key, sub] of Object.entries(child)) {
        if (typeof sub === "string" && (sub.includes("list=RD") || sub.includes("start_radio"))) return true;
        if (key === "playlistId" && typeof sub === "string" && sub.startsWith("RD")) return true;
        if (sub && typeof sub === "object") queue.push(sub);
      }
    }
    return false;
  }

  const rendererKeys = new Set([
    "videoRenderer",
    "richItemRenderer",
    "gridVideoRenderer",
    "compactVideoRenderer",
    "compactMovieRenderer",
    "movieRenderer",
    "videoWithContextRenderer",
    "radioRenderer",
    "compactRadioRenderer",
    "playlistRenderer",
    "compactPlaylistRenderer",
    "playableRenderer",
    "lockupViewModel",
    "reelItemRenderer",
    "shortsLockupViewModel",
    "shortsLockupViewModelV2",
    "shortsLockupViewModelV3",
    "shortsLockupViewModelV4",
    "reelShelfRenderer",
    "richShelfRenderer",
    "richSectionRenderer",
    "shelfRenderer",
    "reelPlayerHeaderSupportedRenderers",
    // Junk-shelf renderers: posts, promos, storefronts and banners.
    "postRenderer",
    "backstagePostRenderer",
    "sharedPostRenderer",
    "statementBannerRenderer",
    "brandVideoShelfRenderer",
    "brandVideoSingletonRenderer",
    "bannerPromoRenderer",
    "primetimePromoRenderer",
    "offlinePromoRenderer",
    "expandedShelfContentsRenderer",
    "horizontalCardListRenderer"
  ]);

  // Keys whose renderer is a Shorts shelf. The whole shelf is removed (rather
  // than each item) so YouTube does not leave an empty "Shorts" heading behind.
  const shortsShelfKeys = new Set([
    "reelShelfRenderer",
    "shortsShelfRenderer",
    "shortsLockupViewModelShelfRenderer"
  ]);

  function isShortKey(key) {
    return /^reelItemRenderer$|^shortsLockupViewModel/i.test(key);
  }

  // Shared walker: does any string anywhere in this node satisfy `test`?
  function anyStringMatches(value, test, limit) {
    const queue = [value];
    const seen = new Set();
    const cap = limit || 200;
    while (queue.length && seen.size < cap) {
      const child = queue.shift();
      if (!child || typeof child !== "object" || seen.has(child)) continue;
      seen.add(child);
      for (const sub of Object.values(child)) {
        if (typeof sub === "string") {
          if (test(sub)) return true;
        } else if (sub && typeof sub === "object") {
          queue.push(sub);
        }
      }
    }
    return false;
  }

  // Recursively collect every value under `key`, at any depth.
  function collectKey(value, key, out, limit) {
    const queue = [value];
    const seen = new Set();
    const cap = limit || 200;
    while (queue.length && seen.size < cap) {
      const child = queue.shift();
      if (!child || typeof child !== "object" || seen.has(child)) continue;
      seen.add(child);
      for (const [k, sub] of Object.entries(child)) {
        if (k === key) out.push(sub);
        if (sub && typeof sub === "object") queue.push(sub);
      }
    }
    return out;
  }

  // Live / upcoming / premieres. YouTube marks these with an explicit overlay
  // style or a live/upcoming badge style string.
  function shelfIsLive(value) {
    const badges = collectKey(value, "metadataBadgeRenderer", []);
    for (const badge of badges) {
      const style = String(badge?.style || "").toUpperCase();
      if (style.includes("LIVE_NOW") || style.includes("_UPCOMING") || style.includes("BADGE_STYLE_TYPE_LIVE")) {
        return true;
      }
    }
    const overlays = collectKey(value, "thumbnailOverlayTimeStatusRenderer", []);
    for (const overlay of overlays) {
      const style = String(overlay?.style || "").toUpperCase();
      if (style === "LIVE" || style === "UPCOMING") return true;
    }
    return false;
  }

  // Community posts: the renderer key itself is the marker, plus /post/ links.
  function shelfIsPosts(value) {
    const queue = [value];
    const seen = new Set();
    while (queue.length && seen.size < 120) {
      const child = queue.shift();
      if (!child || typeof child !== "object" || seen.has(child)) continue;
      seen.add(child);
      for (const [key, sub] of Object.entries(child)) {
        if (/^(postRenderer|backstagePostRenderer|sharedPostRenderer)$/.test(key)) return true;
        if (typeof sub === "string" && /\/post\//.test(sub)) return true;
        if (sub && typeof sub === "object") queue.push(sub);
      }
    }
    return false;
  }

  // YouTube Movies / storefront promos (paid content).
  function shelfIsStorefront(value) {
    const badges = collectKey(value, "metadataBadgeRenderer", []);
    if (badges.some((b) => String(b?.style || "").toUpperCase().includes("YPC"))) return true;
    return anyStringMatches(value, (s) => /^\/movies$|tv\.youtube\.com|\/storefront/.test(s), 150);
  }

  // Brand / featured takeovers.
  function shelfIsPromo(value) {
    return anyStringMatches(
      value,
      (s) => /badgeStyleTypeFeatured|BADGE_STYLE_TYPE_FEATURED/.test(s),
      120
    );
  }

  // "More topics" / "\u0415\u0449\u0451 \u0442\u0435\u043c\u044b": a shelf whose heading names it or that is
  // built from topic chips linking to /feed/* pages.
  const TOPIC_HEADING = /^(more topics|\u0435\u0449\u0451 \u0442\u0435\u043c\u044b|\u0435\u0449\u0435 \u0442\u0435\u043c\u044b|explore more topics)$/;

  // Reads a shelf's heading from whichever renderer shape it uses, and returns
  // the plain text. A generated shelf always has one.
  function shelfHeadingText(value) {
    const header = value?.header || value;
    const title =
      value?.title ||
      header?.shelfHeaderRenderer?.title ||
      header?.feedFilterChipBarRenderer?.title ||
      header?.richShelfHeaderRenderer?.title ||
      header?.title;
    return normalize(
      typeof title === "string" ? title :
      title?.simpleText ||
      (Array.isArray(title?.runs) ? title.runs.map((r) => r?.text || "").join("") : "")
    );
  }

  // True when the shelf advertises a heading. Used by the catch-all
  // "generated shelves" filter: a headingless shelf is the user's own feed.
  function hasShelfHeading(value) {
    return shelfHeadingText(value).length > 0;
  }

  function shelfIsTopics(value) {
    const titleText = shelfHeadingText(value);
    if (TOPIC_HEADING.test(titleText)) return true;
    // Count topic links: a real topic shelf has several /feed/ chip links.
    let topicLinks = 0;
    const queue = [value];
    const seen = new Set();
    while (queue.length && seen.size < 150) {
      const child = queue.shift();
      if (!child || typeof child !== "object" || seen.has(child)) continue;
      seen.add(child);
      for (const sub of Object.values(child)) {
        if (typeof sub === "string" && /^\/feed\//.test(sub)) topicLinks += 1;
        else if (sub && typeof sub === "object") queue.push(sub);
      }
    }
    return topicLinks >= 3;
  }

  // A reelShelfRenderer carries `isShort`-like data only through its items, but
  // YouTube also uses richShelfRenderer for a modern Shorts grid. Detect those
  // by looking for Shorts children or a /shorts/ navigation endpoint.
  function shelfIsShorts(value) {
    if (value?.isShorts === true || value?.isShort === true) return true;
    const queue = [value];
    const seen = new Set();
    while (queue.length && seen.size < 120) {
      const child = queue.shift();
      if (!child || typeof child !== "object" || seen.has(child)) continue;
      seen.add(child);
      for (const [key, sub] of Object.entries(child)) {
        if (isShortKey(key) || shortsShelfKeys.has(key)) return true;
        if (typeof sub === "string" && (sub.startsWith("/shorts/") || sub === "SHORTS")) return true;
        if (sub && typeof sub === "object") queue.push(sub);
      }
    }
    return false;
  }

  function filterNode(node, depth) {
    if (!node || typeof node !== "object" || depth > 40) return;
    for (const [key, value] of Object.entries(node)) {
      if (!value || typeof value !== "object") continue;
      if (rendererKeys.has(key)) {
        const isShelf = /shelf/i.test(key) || /Section/i.test(key);
        // "isShort" means this item itself is a Short; a shelf that merely
        // contains Shorts is a different thing and is handled separately.
        const isShortItem = isShortKey(key);
        const isShortsShelf = isShelf && shelfIsShorts(value);

        // Junk blocks. Each is gated on its own setting, so nothing is removed
        // unless the user asked for it. Posts and banners are their own
        // renderers rather than shelves, so they are checked unconditionally.
        let junk = false;
        if (settings.hideLiveStreams && shelfIsLive(value)) junk = true;
        else if (settings.hideCommunityPosts && shelfIsPosts(value)) junk = true;
        else if (settings.hideStorefrontShelves && shelfIsStorefront(value)) junk = true;
        else if (settings.hidePromoShelves && shelfIsPromo(value)) junk = true;
        else if (settings.hideTopicShelves && isShelf && shelfIsTopics(value)) junk = true;
        else if (settings.hideGeneratedShelves && isShelf &&
          !isShortsShelf && !shelfIsTopics(value) && hasShelfHeading(value)) junk = true;

        // A Short or a Shorts shelf is removed by "Hide Shorts" alone. The
        // channel and content rules apply to everything else only, which is
        // what stops members-only from deleting Shorts.
        const hide = junk || ((isShortItem || isShortsShelf)
          ? shortMatches()
          : channelMatches(value) || contentMatches(value, key));
        if (hide) {
          delete node[key];
          continue;
        }
      }
      filterNode(value, depth + 1);
    }
  }

  function installConfig(event) {
    const data = event.data;
    if (!data || data.source !== "freshfeed-content" || data.type !== "index") return;
    index = {
      ids: new Set(Array.isArray(data.index?.ids) ? data.index.ids.map((value) => String(value).toLowerCase()) : []),
      handles: new Set(Array.isArray(data.index?.handles) ? data.index.handles.map((value) => String(value).toLowerCase()) : []),
      customUrls: new Set(Array.isArray(data.index?.customUrls) ? data.index.customUrls.map((value) => String(value).toLowerCase()) : []),
      names: new Set(Array.isArray(data.index?.names) ? data.index.names.map(normalize) : [])
    };
    blockedIndex = {
      ids: new Set(Array.isArray(data.blockedIndex?.ids) ? data.blockedIndex.ids.map((value) => String(value).toLowerCase()) : []),
      handles: new Set(Array.isArray(data.blockedIndex?.handles) ? data.blockedIndex.handles.map((value) => String(value).toLowerCase()) : []),
      customUrls: new Set(Array.isArray(data.blockedIndex?.customUrls) ? data.blockedIndex.customUrls.map((value) => String(value).toLowerCase()) : []),
      names: new Set(Array.isArray(data.blockedIndex?.names) ? data.blockedIndex.names.map(normalize) : [])
    };
    settings = { ...settings, ...(data.settings || {}) };
  }

  window.addEventListener("message", installConfig, true);
  window.postMessage({ source: "freshfeed-page-filter", type: "ready" }, "*");

  const FILTERABLE_URL = /\/youtubei\/v1\/(?:browse|next|player|reel|search)(?:\?|$)/;

  function hasIndex() {
    return index.ids.size || index.handles.size || index.customUrls.size || index.names.size ||
      blockedIndex.ids.size || blockedIndex.handles.size || blockedIndex.customUrls.size || blockedIndex.names.size;
  }

  function applyFilterToJson(data) {
    if (!data || typeof data !== "object") return false;
    // Never touch Shorts player responses: the user asked to leave the
    // /shorts/<id> page (and its player) completely alone. The reel watch
    // endpoint returns a reelWatchSequenceRenderer, so guard on that too.
    if (data?.playerResponse?.videoDetails?.isShorts) return false;
    if (data?.reelWatchSequenceRenderer) return false;
    const before = JSON.stringify(data).length;
    filterNode(data, 0);
    return JSON.stringify(data).length !== before;
  }

  async function filterResponse(response, url) {
    if (!response || !response.ok) return response;
    const requestUrl = typeof url === "string" && url ? url : (response.url || "");
    if (!FILTERABLE_URL.test(requestUrl)) return response;
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("json")) return response;
    try {
      const data = await response.clone().json();
      if (!applyFilterToJson(data)) return response;
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.delete("content-encoding");
      return new Response(JSON.stringify(data), {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    } catch {
      return response;
    }
  }

  // Filter both fetch() and XMLHttpRequest responses. YouTube still uses XHR
  // for some older surfaces, and breakage there was invisible before.
  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function (input, init) {
      const requestUrl = typeof input === "string" ? input : (input && input.url) || "";
      const result = originalFetch.apply(this, arguments);
      if (!hasIndex()) return result;
      return result.then((response) => filterResponse(response, requestUrl));
    };
  }

  const XHR = window.XMLHttpRequest;
  if (typeof XHR === "function") {
    const open = XHR.prototype.open;
    const send = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      this.__ffUrl = url;
      return open.apply(this, arguments);
    };
    XHR.prototype.send = function () {
      if (!hasIndex() || !FILTERABLE_URL.test(String(this.__ffUrl || ""))) {
        return send.apply(this, arguments);
      }
      this.__ffFilterXhr = true;
      this.addEventListener("readystatechange", () => {
        if (this.readyState !== 4 || !this.__ffFilterXhr) return;
        this.__ffFilterXhr = false;
        if (this.responseType && this.responseType !== "" && this.responseType !== "text" && this.responseType !== "json") return;
        try {
          const parsed = typeof this.response === "string" ? JSON.parse(this.response) : this.response;
          if (!parsed || typeof parsed !== "object") return;
          if (!applyFilterToJson(parsed)) return;
          const text = JSON.stringify(parsed);
          Object.defineProperty(this, "response", { configurable: true, get: () => (this.responseType === "json" ? JSON.parse(text) : text) });
          Object.defineProperty(this, "responseText", { configurable: true, get: () => text });
        } catch {
          // Leave the original response untouched when anything goes wrong.
        }
      });
      return send.apply(this, arguments);
    };
  }
}());
