(function () {
  "use strict";

  const CARD_SELECTOR = [
    "ytd-rich-item-renderer",
    "ytd-rich-grid-media",
    "ytd-video-renderer",
    "ytd-grid-video-renderer",
    "ytd-compact-video-renderer",
    "ytd-rich-shelf-renderer",
    "ytd-reel-item-renderer",
    "ytd-reel-video-renderer",
    "ytd-shorts-lockup-view-model",
    "ytd-shorts-lockup-view-model-v2",
    "ytm-shorts-lockup-view-model",
    "ytm-shorts-lockup-view-model-v2",
    "yt-shorts-lockup-view-model",
    "yt-shorts-lockup-view-model-v2",
    "yt-lockup-view-model",
    "yt-lockup-content-view-model",
    "yt-lockup-compact-view-model",
    "yt-lockup-grid-view-model",
    "yt-lockup-view-model-v2"
  ].join(", ");
  // Cards that represent a single Short. YouTube keeps renaming these tags, so
  // this list must stay ahead of the live DOM. Each entry is a tag YouTube has
  // shipped for a Shorts lockup at some point.
  const SHORT_CARD_SELECTOR = [
    "ytd-reel-item-renderer",
    "ytd-reel-video-renderer",
    "ytd-shorts-lockup-view-model",
    "ytd-shorts-lockup-view-model-v2",
    "ytd-shorts-lockup-view-model-v3",
    "ytm-shorts-lockup-view-model",
    "ytm-shorts-lockup-view-model-v2",
    "yt-shorts-lockup-view-model",
    "yt-shorts-lockup-view-model-v2",
    "shorts-lockup-view-model"
  ].join(", ");

  // Shelves/sections that exist only to hold Shorts. When "Hide Shorts" is on
  // the whole shelf is removed, otherwise YouTube leaves an empty "Shorts"
  // heading and a broken horizontal strip behind.
  const SHORTS_SHELF_SELECTOR = [
    "ytd-reel-shelf-renderer",
    "ytm-shorts-shelf-renderer",
    "grid-shelf-view-model",
    "ytd-rich-shelf-renderer[is-shorts]",
    "ytd-shelf-renderer[is-shorts]",
    "[is-shorts][is-shelf]",
    "ytd-rich-section-renderer[is-shorts]"
  ].join(", ");
  const CHANNEL_LINK_SELECTOR = 'a[href*="/@"], a[href*="/channel/"], a[href*="/c/"], a[href*="/user/"]';
  // Surfaces whose cards are matched against the subscribed / blacklisted channel index.
  // This intentionally covers every YouTube feed surface: home, search results,
  // watch-page recommendations, channel pages, feed tabs, playlists and hashtags.
  const FILTER_SURFACES = [
    "/feed/subscriptions",
    "/feed/trending",
    "/feed/explore",
    "/feed/history",
    "/feed/channels",
    "/watch",
    "/results",
    "/playlist",
    "/channel/",
    "/c/",
    "/user/",
    "/@",
    "/hashtag/",
    "/live"
  ];

  // The Shorts player (/shorts/<id>) is off limits: the user explicitly asked
  // to leave it untouched even while "Hide Shorts" is on. Every filter helper
  // below funnels through this, so a single check keeps the whole page clean.
  function isShortsPlayerPage() {
    return location.pathname === "/shorts" || location.pathname.startsWith("/shorts/");
  }

  function isFilterSurface() {
    if (isShortsPlayerPage()) {
      return false;
    }
    if (location.pathname === "/") {
      return true;
    }
    return FILTER_SURFACES.some((surface) => location.pathname.startsWith(surface));
  }
  // Below this many channels a sync is treated as suspect rather than complete.
  // It only ever arms the opportunistic DOM harvest -- it never prompts the user
  // to navigate anywhere.
  const IMPLAUSIBLY_FEW_CHANNELS = 20;

  // The two surfaces where YouTube itself pages through the full subscription
  // list. Both are usable for harvesting: the page is real, the session is real,
  // and YouTube does the requesting. /feed/channels is the legacy grid,
  // /feed/subscriptions the modern one.
  function isSubscriptionListPage() {
    return location.pathname === "/feed/channels" || location.pathname === "/feed/subscriptions";
  }

  const DEFAULT_CHANNELS = { ids: [], handles: [], customUrls: [], names: [], records: [] };
  const DEFAULT_SETTINGS = {
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
    endlessFeed: true,
    feedLookahead: true,
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
  // Cards that were inserted but whose channel data had not attached yet. They
  // stay invisible (via the data-ff-pending CSS rule) until resolved.
  const pendingCards = new Set();

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
      "#byline",
      "#owner-name a",
      "#owner-name",
      ".yt-core-attributed-string--link-inherit-color",
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
      "yt-thumbnail-overlay-badge-view-model .badge-shape-wiz__text, " +
      ".badge-shape-wiz__text"
    );
    const durationSeconds = parseDurationSeconds(durationElement && durationElement.textContent);
    const metadata = card && card.querySelector("#metadata-line, ytd-video-meta-block, yt-content-metadata-view-model, .ytd-video-meta-block");
    const daysOld = ageInDays(metadata && metadata.textContent);
    // Only an explicit members-only badge counts. A bare ytd-badge-supported-renderer
    // also renders for LIVE / New / 4K / CC, so matching it hid ordinary videos.
    const membersBadge = card && card.querySelector(
      ".badge-style-type-members-only, ytd-badge-supported-renderer[class*='members-only'], " +
      "[class*='badge-style-type-members-only'], [class*='badge-style-type-sponsors-only']"
    );
    return {
      isPlayable:
        card.matches("ytd-rich-shelf-renderer[is-playable], ytd-playlist-renderer[is-playable], ytm-playlist-renderer[data-is-playable]") ||
        Boolean(card.querySelector('[is-playable]')) ||
        /(^|\s)playables(\s|$)/.test(text) ||
        aria.includes("playables"),
      isMembersOnly: Boolean(membersBadge) ||
        /members[- ]only|\u0442\u043e\u043b\u044c\u043a\u043e \u0434\u043b\u044f \u0441\u043f\u043e\u043d\u0441\u043e\u0440\u043e\u0432|\u0441\u043f\u043e\u043d\u0441\u043e\u0440\u0441\u043a\u0438\u0439/.test(text),
      // Mix/Radio is a playlist, not any card whose description says "mix".
      // Requiring the RD playlist link or a radio renderer removes the false
      // positives that were hitting ordinary videos.
      isMixRadio:
        card.matches("ytd-radio-renderer, ytd-compact-radio-renderer, ytd-compact-playlist-renderer") ||
        Boolean(card.querySelector('a[href*="list=RD"], a[href*="start_radio"]')),
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

  // A Short must only ever be governed by "Hide Shorts". Everything else
  // (members-only, playables, date, duration) is meaningless for Shorts and
  // previously caused Shorts to vanish when an unrelated filter was enabled.
  function shouldHideShort(card) {
    return Boolean(state.settings.hideShorts);
  }

  function shouldHideByContent(card) {
    const flags = cardContentFlags(card, false);
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
    if (isShort && shouldHideShort()) {
      return true;
    }
    if (blockedMatch && state.settings.hideBlacklisted) {
      return true;
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

  // True when the card links to /shorts/<id> somewhere inside it. This is the
  // most reliable Shorts signal because it survives every YouTube redesign.
  function hasShortsLink(card) {
    if (!card || !card.querySelector) {
      return false;
    }
    if (card.querySelector('a[href^="/shorts/"], a[href*="youtube.com/shorts/"], a[href*="/shorts/"]')) {
      return true;
    }
    const rawData = card.data || card.__data || (card.wrappedJSObject && (card.wrappedJSObject.data || card.wrappedJSObject.__data));
    if (!rawData) {
      return false;
    }
    const queue = [rawData];
    const seen = new Set();
    while (queue.length && seen.size < 200) {
      const value = queue.shift();
      if (!value || typeof value !== "object" || seen.has(value)) {
        continue;
      }
      seen.add(value);
      for (const child of Object.values(value)) {
        if (typeof child !== "string") {
          if (child && typeof child === "object") {
            queue.push(child);
          }
          continue;
        }
        if (child.startsWith("/shorts/") || child.includes("/shorts/")) {
          return true;
        }
      }
    }
    return false;
  }

  // The Shorts shelf/section title is usually rendered as a link to
  // /shorts/. Containers holding that link (but not the individual Short
  // cards) are the shelf wrappers that must be hidden as a whole.
  function containerForShortsLink(card) {
    const link = card.querySelector('a[href^="/shorts/"], a[href*="/shorts/"]');
    if (!link) {
      return null;
    }
    return link.closest(
      "ytd-rich-shelf-renderer, ytd-reel-shelf-renderer, ytd-shelf-renderer, " +
      "ytd-rich-section-renderer, ytd-item-section-renderer, ytd-horizontal-card-list-renderer, " +
      "yt-horizontal-card-list-view-model, ytm-shorts-shelf-renderer"
    );
  }

  // Reliable Shorts detection. Element tag names alone are not enough, because
  // YouTube renders Shorts through several wrappers depending on the surface,
  // so this also checks the explicit is-shorts attribute, a /shorts/ link, and
  // the inline renderer data.
  function isShortCard(card) {
    if (!card || !card.matches) {
      return false;
    }
    if (card.matches(SHORT_CARD_SELECTOR)) {
      return true;
    }
    if (card.hasAttribute("is-shorts") || card.hasAttribute("is-short")) {
      return true;
    }
    // A Shorts lockup nested inside a generic card (search results wrap each
    // result in a plain container) still makes that card a Short.
    if (card.querySelector(SHORT_CARD_SELECTOR)) {
      return true;
    }
    if (card.querySelector('[is-shorts], [class*="shortsLockup"], [class*="shorts-lockup"]')) {
      return true;
    }
    return hasShortsLink(card);
  }

  // Shorts shelves must disappear entirely, otherwise YouTube leaves an empty
  // "Shorts" heading and a broken horizontal strip behind.
  function hideShortsContainers() {
    if (!state.settings.hideShorts || !state.enabled || isShortsPlayerPage()) {
      document.querySelectorAll("[data-ff-shelf-hidden='1']").forEach((element) => element.removeAttribute("data-ff-shelf-hidden"));
      return;
    }
    document.querySelectorAll(SHORTS_SHELF_SELECTOR).forEach((shelf) => {
      const hasShortsContent = shelf.matches("ytd-reel-shelf-renderer, ytm-shorts-shelf-renderer, ytd-rich-shelf-renderer[is-shorts], ytd-shelf-renderer[is-shorts]") ||
        Boolean(shelf.querySelector(SHORT_CARD_SELECTOR)) ||
        Boolean(shelf.querySelector('a[href^="/shorts/"], a[href*="/shorts/"]'));
      if (hasShortsContent) {
        shelf.setAttribute("data-ff-shelf-hidden", "1");
      } else {
        shelf.removeAttribute("data-ff-shelf-hidden");
      }
    });
  }

  // Resolve a card whose decision was deferred. Returns true when the card was
  // handled (so the caller does not re-process it this pass).
  function resolvePendingCard(card) {
    const canDecide = isShortCard(card) || titleOf(card) || hasChannelData(extractChannel(card));
    if (!canDecide) {
      return false;
    }
    card.removeAttribute("data-ff-pending");
    markCard(card);
    return true;
  }

  // Called the instant a card node is inserted. It marks the card as pending so
  // the CSS keeps it invisible, then decides as soon as the data is available.
  // This is what removes the flash: the card never paints before its fate is
  // known.
  function markCardPending(card) {
    if (!state.enabled || !card || !card.nodeType || card.nodeType !== 1) {
      return;
    }
    if (!card.matches || !card.matches(CARD_SELECTOR)) {
      return;
    }
    if (card.hasAttribute("data-ff-checked")) {
      return;
    }
    card.setAttribute("data-ff-pending", "1");
    // Try to settle it right away; if the channel data has not attached yet,
    // resolvePendingCard runs again on the scheduled scan (typically a frame or
    // two later), by which point the attributes are present.
    if (!resolvePendingCard(card)) {
      pendingCards.add(card);
    }
  }

  function markCard(card) {
    card.removeAttribute("data-ff-pending");
    pendingCards.delete(card);
    const href = firstVideoHref(card);
    const channel = extractChannel(card);
    if (!hasChannelData(channel) && !titleOf(card)) {
      // No data yet. This is YouTube's placeholder/skeleton card. Showing it now
      // is what produces the visible loading grids that then vanish, so keep it
      // invisible and revisit it on a later scan. resolvePendingCard() gives up
      // after a few passes and shows it, so nothing can be hidden forever.
      if (state.enabled && isFilterSurface()) {
        card.setAttribute("data-ff-pending", "1");
        pendingCards.add(card);
      }
      return;
    }
    card.setAttribute("data-ff-checked", "1");
    card.setAttribute("data-ff-href", href);
    const isShort = isShortCard(card);
    // A Short is decided by "Hide Shorts" alone; a normal card is decided by the
    // channel rules plus the content filters.
    const hide = isShort
      ? shouldHideShort()
      : (isHiddenChannel(channel, false) || shouldHideByContent(card));
    if (state.enabled && hide) {
      card.setAttribute("data-ff-hidden", "1");
      const container = isShort ? containerForShortsLink(card) : null;
      if (container && container !== card && !container.hasAttribute("data-ff-hidden")) {
        container.setAttribute("data-ff-hidden", "1");
        container.setAttribute("data-ff-shelf-hidden", "1");
      }
    } else {
      card.removeAttribute("data-ff-hidden");
    }
  }

  function clearHiddenCards(clearChecked) {
    document.querySelectorAll("[data-ff-hidden='1']").forEach((card) => card.removeAttribute("data-ff-hidden"));
    document.querySelectorAll("[data-ff-shelf-hidden='1']").forEach((card) => card.removeAttribute("data-ff-shelf-hidden"));
    if (clearChecked) {
      document.querySelectorAll("[data-ff-checked='1']").forEach((card) => {
        card.removeAttribute("data-ff-checked");
        card.removeAttribute("data-ff-href");
      });
    }
  }

  // "More topics" / "\u0415\u0449\u0451 \u0442\u0435\u043c\u044b" is the chip row YouTube shows near the top of
  // the home feed. Each chip is a topic link, and the whole block lives in a
  // shelf-like renderer, so it can be removed as a unit.
  const TOPIC_CHIP_SELECTOR = [
    "ytd-feed-nudge-renderer",
    "ytd-rich-shelf-renderer[is-show-more-rows]",
    "yt-chip-cloud-renderer",
    "ytd-chip-cloud-renderer",
    "iron-selector#chips"
  ].join(", ");

  // A topic shelf is identifiable by its "More topics" heading and by chips
  // that link to /feed/ or topic browse endpoints rather than to a video.
  const TOPIC_TEXT = /^(more topics|\u0435\u0449\u0451 \u0442\u0435\u043c\u044b|\u0435\u0449\u0435 \u0442\u0435\u043c\u044b|explore more topics)$/;

  function isTopicShelf(element) {
    if (!element || !element.querySelectorAll) return false;
    const heading = element.querySelector("#title, #header, h2, .shelf-header-title, yt-formatted-string#title");
    const headingText = normName(heading && heading.textContent);
    if (TOPIC_TEXT.test(headingText)) return true;
    // Topic chips are links to /feed/* topic pages (not to a channel or video).
    const topicLinks = element.querySelectorAll('a[href^="/feed/"]');
    return topicLinks.length >= 3;
  }

  // --- Junk shelf classification -------------------------------------------
  // YouTube injects many promoted/auto-generated shelves into the feed. Each
  // classifier below matches ONE kind so the matching setting can hide it.
  // They are intentionally narrow: a selector that matches too broadly would
  // remove legitimate videos, which is worse than showing a promo block.

  function shelfHeadingText(element) {
    const heading = element.querySelector(
      "#title, #header, h2, .shelf-header-title, yt-formatted-string#title, " +
      "#rich-shelf-header h2, .ytd-rich-shelf-renderer #title"
    );
    return normName(heading && heading.textContent);
  }

  // Live / upcoming / premiere streams. Detection uses the exact badge classes
  // YouTube ships. A bare ytd-badge-supported-renderer is deliberately NOT
  // used: it also renders for New, 4K and CC, and matching it caused the
  // members-only/Shorts bug.
  function isLiveShelf(element) {
    if (!element || !element.querySelector) return false;
    if (element.querySelector(
      ".badge-style-type-live-now-alternate, .badge-style-type-live-now, .badge-style-type-upcoming, " +
      "ytd-thumbnail-overlay-time-status-renderer[overlay-style='LIVE'], " +
      "ytd-thumbnail-overlay-time-status-renderer[overlay-style='UPCOMING']"
    )) {
      return true;
    }
    const text = normName(element.textContent);
    return /(^|\s)(live now|upcoming|premieres|streamed)\b/.test(text) ||
      /\u0442\u0440\u0430\u043d\u0441\u043b\u044f\u0446\u0438\u044f|\u043f\u0440\u044f\u043c\u043e\u0439 \u044d\u0444\u0438\u0440|\u043f\u0440\u0435\u043c\u044c\u0435\u0440\u0430|\u0431\u0443\u0434\u0435\u0442 \u0442\u0440\u0430\u043d\u0441\u043b\u044f\u0446\u0438\u044f/.test(text);
  }

  // Community posts. YouTube renders these as rich items flagged is-post, and
  // every one links to a /post/ URL.
  function isPostShelf(element) {
    if (!element || !element.querySelector) return false;
    if (element.matches("ytd-rich-item-renderer[is-post], ytd-post-renderer")) return true;
    if (element.querySelector("ytd-post-renderer, ytd-rich-item-renderer[is-post]")) return true;
    const postLinks = element.querySelectorAll('a[href*="/post/"], a[href*="/posts/"]');
    return postLinks.length >= 1 && Boolean(element.querySelector("#author-thumbnail, #backstage-post-renderer, #poll-attachment"));
  }

  // YouTube Movies / TV storefront shelves. They are paid storefront promos and
  // are consistently marked with the ypc (YouTube Premium Content) badge, a
  // link to the Movies channel, or an explicit "Movies" / "Store" heading.
  function isStorefrontShelf(element) {
    if (!element || !element.querySelector) return false;
    if (element.querySelector(".badge-style-type-ypc, [class*='ypc-offer'], yt-button-shape a[href*='tv.youtube'], a[href*='/movies']")) {
      return true;
    }
    const text = shelfHeadingText(element);
    return /^(movies|movies & tv|youtube movies|store|rent or buy|\u0444\u0438\u043b\u044c\u043c\u044b|\u043f\u043e\u043a\u0443\u043f\u043a\u0438)$/.test(text);
  }

  // Brand/featured takeovers: statement banners, brand video shelves and the
  // "featured" badge YouTube puts on sponsored placements.
  function isPromoShelf(element) {
    if (!element || !element.matches) return false;
    if (element.matches(
      "ytd-statement-banner-renderer, ytd-brand-video-shelf-renderer, ytd-brand-video-singleton-renderer, " +
      "ytd-banner-promo-renderer, ytd-primetime-promo-renderer, ytd-feed-nudge-renderer"
    )) {
      return true;
    }
    if (element.querySelector(
      "ytd-statement-banner-renderer, ytd-brand-video-shelf-renderer, ytd-banner-promo-renderer, " +
      "ytd-primetime-promo-renderer, ytd-offline-promo-renderer"
    )) {
      return true;
    }
    return Boolean(element.querySelector("#featured-badge, [class*='badge-style-type-featured']"));
  }

  // Any YouTube-generated themed shelf: a horizontal row of videos or playlists
  // that YouTube assembled around a topic, rather than the user's own feed.
  // These are "rich shelves" with a non-empty heading. The caller decides
  // whether the user opted in.
  function isGeneratedShelf(element) {
    if (!element || !element.matches) return false;
    const isShelf =
      element.matches(
        "ytd-rich-shelf-renderer, ytd-shelf-renderer, ytd-reel-shelf-renderer, " +
        "ytd-horizontal-card-list-renderer, grid-shelf-view-model, yt-horizontal-card-list-view-model, " +
        "ytd-expanded-shelf-contents-renderer, ytd-rich-section-renderer"
      );
    if (!isShelf) return false;
    // Never remove the wrappers that hold the user's own grid items.
    if (element.matches("ytd-rich-grid-renderer, ytd-item-section-renderer, #contents, #primary")) return false;
    // A generated shelf always has a heading. A shelf with no heading is almost
    // always the user's own continuation content, so it is left alone.
    const heading = shelfHeadingText(element);
    if (!heading) return false;
    // "More topics" and Shorts have their own dedicated settings; do not let
    // the catch-all duplicate them.
    if (TOPIC_TEXT.test(heading)) return false;
    if (isShortShelfElement(element)) return false;
    // A "rich-section-renderer" is only a generated shelf when it actually
    // wraps a shelf; otherwise it may be a plain container.
    if (element.matches("ytd-rich-section-renderer")) {
      return Boolean(element.querySelector(
        "ytd-rich-shelf-renderer, ytd-shelf-renderer, ytd-horizontal-card-list-renderer, " +
        "grid-shelf-view-model, yt-horizontal-card-list-view-model"
      ));
    }
    return true;
  }

  function isShortShelfElement(element) {
    return Boolean(element.matches && element.matches(
      "ytd-reel-shelf-renderer, ytm-shorts-shelf-renderer, ytd-rich-shelf-renderer[is-shorts], ytd-shelf-renderer[is-shorts]"
    )) || Boolean(element.querySelector && element.querySelector(
      "ytd-reel-shelf-renderer, ytm-shorts-shelf-renderer, ytd-rich-shelf-renderer[is-shorts]"
    ));
  }

  // Surveys / feedback prompts / premium nags. These are overlays rather than
  // feed items, so hiding them cannot affect the grid layout.
  const SURVEY_SELECTOR = [
    "ytd-inline-survey-renderer",
    "ytd-survey-renderer",
    "ytd-primetime-promo-renderer",
    "ytd-offline-promo-renderer",
    "yt-mealbar-promo-renderer",
    "ytm-mealbar-promo-renderer",
    "upsell-view-model",
    "ytd-enforcement-message-view-model",
    "tp-yt-paper-dialog #survey",
    "ytd-popup-container #survey"
  ].join(", ");

  // Shelves whose own wrapper carries the is-shorts marker, used to stop the
  // generic shelf filter from swallowing the Shorts shelf.
  const SHELF_SCAN_SELECTOR = [
    "ytd-rich-shelf-renderer",
    "ytd-shelf-renderer",
    "ytd-reel-shelf-renderer",
    "ytd-horizontal-card-list-renderer",
    "grid-shelf-view-model",
    "yt-horizontal-card-list-view-model",
    "ytd-expanded-shelf-contents-renderer",
    "ytd-rich-section-renderer",
    "ytd-rich-item-renderer",
    "ytd-post-renderer",
    "ytd-statement-banner-renderer",
    "ytd-brand-video-shelf-renderer",
    "ytd-brand-video-singleton-renderer",
    "ytd-banner-promo-renderer",
    "ytd-primetime-promo-renderer",
    "ytd-offline-promo-renderer"
  ].join(", ");

  function hideTopicShelves() {
    if (!state.enabled) {
      return;
    }
    const settings = state.settings;
    document.querySelectorAll("[data-ff-topics-hidden='1']").forEach((element) => element.removeAttribute("data-ff-topics-hidden"));
    if (!settings.hideTopicShelves && !settings.hideLiveStreams && !settings.hideCommunityPosts &&
        !settings.hideStorefrontShelves && !settings.hidePromoShelves && !settings.hideGeneratedShelves) {
      return;
    }
    document.querySelectorAll(SHELF_SCAN_SELECTOR).forEach((element) => {
      // Never touch a shelf while its own dedicated setting is off.
      let hide = false;
      if (settings.hideTopicShelves && isTopicShelf(element)) hide = true;
      else if (settings.hideLiveStreams && isLiveShelf(element)) hide = true;
      else if (settings.hideCommunityPosts && isPostShelf(element)) hide = true;
      else if (settings.hideStorefrontShelves && isStorefrontShelf(element)) hide = true;
      else if (settings.hidePromoShelves && isPromoShelf(element)) hide = true;
      else if (settings.hideGeneratedShelves && isGeneratedShelf(element)) hide = true;
      if (hide) {
        element.setAttribute("data-ff-topics-hidden", "1");
      }
    });
  }

  // Surveys and upsell popups are not feed items; they are separate elements.
  function hideJunkOverlays() {
    if (!state.enabled || !state.settings.hideSurveys) {
      document.querySelectorAll("[data-ff-junk-hidden='1']").forEach((element) => element.removeAttribute("data-ff-junk-hidden"));
      return;
    }
    document.querySelectorAll(SURVEY_SELECTOR).forEach((element) => {
      element.setAttribute("data-ff-junk-hidden", "1");
    });
  }

  function scanHome() {
    if (!homeActive || !state.enabled || isShortsPlayerPage()) {
      return;
    }
    hideShortsContainers();
    hideTopicShelves();
    hideJunkOverlays();
    // Settle anything that was marked pending but could not be decided on
    // insertion (its channel data had not attached yet).
    pendingCards.forEach((card) => {
      if (!card.isConnected) {
        pendingCards.delete(card);
        card.removeAttribute("data-ff-pending");
        return;
      }
      if (!resolvePendingCard(card)) {
        // Still no data. Give up after a few passes so a card is never left
        // invisible forever; an undecidable card is shown rather than hidden.
        const attempts = (Number(card.getAttribute("data-ff-pending-attempts")) || 0) + 1;
        card.setAttribute("data-ff-pending-attempts", String(attempts));
        if (attempts >= 3) {
          card.removeAttribute("data-ff-pending");
          card.removeAttribute("data-ff-pending-attempts");
          pendingCards.delete(card);
          // Treat it as checked so it is not reconsidered on every scan.
          card.setAttribute("data-ff-checked", "1");
        }
      }
    });
    document.querySelectorAll(CARD_SELECTOR + ":not([data-ff-checked])").forEach((card) => {
      card.removeAttribute("data-ff-pending");
      pendingCards.delete(card);
      markCard(card);
    });
    document.querySelectorAll(CARD_SELECTOR + "[data-ff-checked='1']").forEach((card) => {
      const href = firstVideoHref(card);
      if (href !== card.getAttribute("data-ff-href")) {
        card.removeAttribute("data-ff-checked");
        markCard(card);
      }
    });
    // Keep a buffer of feed content ready below the fold.
    schedulePrefetch();
    // Watch for the feed genuinely running out. The recovery decision lives
    // inside recoverFeed, so scheduling on every scan is cheap: it early-returns
    // while there is still content, and the timer slot keeps it to one pending
    // check no matter how often the mutation observer fires.
    scheduleEndlessRecovery();
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
    // Never leave a card invisible because we stopped scanning.
    pendingCards.forEach((card) => {
      card.removeAttribute("data-ff-pending");
      card.removeAttribute("data-ff-pending-attempts");
    });
    pendingCards.clear();
    stopFeedLookahead();
    stopEndlessFeed();
    clearHiddenCards(false);
  }

  // --- Background lookahead -------------------------------------------------
  // YouTube only loads more home-feed items when the sentinel near the bottom
  // becomes visible. Because FreshFeed then hides most of what arrives, the
  // feed can hit its end long before the viewport fills, and the user sees
  // "loading". This nudges that sentinel into view ahead of time so a buffer of
  // items is always ready.
  //
  // Guard rails (all required):
  //   * a hard cap on how many nudge rounds may run per page load
  //   * a cooldown between rounds, so loading can never free-run
  //   * it only runs while the user is near the bottom, so an idle tab never
  //     triggers loading on its own
  //   * it stops entirely once the feed stops growing
  const LOOKAHEAD = {
    enabled: true,
    // How many viewport-heights of content to keep below the fold.
    targetScreens: 4,
    // How long one round waits for YouTube to actually append, in ms.
    // YouTube needs 1-3s in practice. The old 700ms single-shot verdict could
    // not tell a slow server from a dead end, so three rounds of perfectly
    // normal latency looked like three dead rounds and shut the whole feature
    // off for the rest of the page load.
    settleMs: 6000,
    // Poll interval inside that settle window.
    settlePollMs: 300,
    // Tick of the self-sustaining timer. This doubles as the minimum gap
    // between requests, so the loop still cannot free-run.
    tickMs: 900,
    // Give up on the whole page load only after this many consecutive rounds
    // that YouTube genuinely could not answer.
    maxDeadRounds: 6
  };

  let lookaheadTimer = null;
  let lookaheadRounds = 0;
  let lookaheadDeadRounds = 0;
  let lookaheadLastRun = 0;
  let lookaheadRunning = false;
  let lookaheadActive = false;
  let lookaheadScrollHandler = null;

  function countFeedItems() {
    return document.querySelectorAll(CARD_SELECTOR).length;
  }

  function findFeedContinuation() {
    // The sentinel YouTube uses to trigger the next page. Different surfaces
    // name it differently, so try the known shapes.
    return document.querySelector(
      "ytd-continuation-item-renderer, #continuations ytd-continuation-item-renderer, " +
      "ytd-rich-grid-renderer #continuations, ytd-item-section-continuations, " +
      "ytd-continuation-item-renderer #ghost-cards, #continuation-item"
    ) || document.querySelector("ytd-continuation-item-renderer");
  }

  // Markers that mean "YouTube is fetching right now". While any of these is
  // present the feed is busy, not finished. The previous version treated a
  // missing continuation element as "nothing left to load" even in the middle
  // of a request, and banked that as a dead round without ever trying.
  const LOADING_SELECTOR = [
    "ytd-continuation-item-renderer[loading]",
    "ytd-progress-spinner",
    "ytd-loading-spinner",
    "#continuations [loading]",
    "[aria-busy='true']"
  ].join(", ");

  function feedIsLoading() {
    return Boolean(document.querySelector(LOADING_SELECTOR));
  }

  // How much content is left below the fold, expressed in viewport-heights.
  function feedBufferScreens() {
    const doc = document.scrollingElement || document.documentElement;
    if (!doc) return Infinity;
    const remaining = doc.scrollHeight - (doc.scrollTop + window.innerHeight);
    return remaining / Math.max(1, window.innerHeight);
  }

  function stopFeedLookahead() {
    lookaheadActive = false;
    if (lookaheadTimer) {
      clearTimeout(lookaheadTimer);
      lookaheadTimer = null;
    }
    if (lookaheadScrollHandler) {
      window.removeEventListener("scroll", lookaheadScrollHandler);
      lookaheadScrollHandler = null;
    }
  }

  function resetFeedLookahead() {
    stopFeedLookahead();
    lookaheadRounds = 0;
    lookaheadDeadRounds = 0;
    lookaheadLastRun = 0;
    lookaheadRunning = false;
  }

  // Re-arm the loop. Every exit path from runLookahead goes through here, which
  // is what makes the feature work in the background: previously the only way
  // to get another round was a user scroll event, so a tab left alone could
  // never make progress.
  function armLookaheadTimer() {
    if (lookaheadTimer) return;
    lookaheadTimer = window.setTimeout(() => {
      lookaheadTimer = null;
      runLookahead();
    }, LOOKAHEAD.tickMs);
  }

  function schedulePrefetch() {
    if (!state.enabled || !state.settings.feedLookahead || !LOOKAHEAD.enabled) {
      stopFeedLookahead();
      return;
    }
    if (!isFilterSurface() || isShortsPlayerPage() || location.pathname !== "/") {
      stopFeedLookahead();
      return;
    }
    if (!lookaheadActive) {
      lookaheadActive = true;
      lookaheadScrollHandler = () => runLookahead();
      window.addEventListener("scroll", lookaheadScrollHandler, { passive: true });
    }
    armLookaheadTimer();
    runLookahead();
  }

  // Ask YouTube for the next page without ever moving the page.
  //
  // The preferred route is the app's own API. The fallback deliberately does NOT
  // scroll the sentinel into view: that is how YouTube triggers its own fetch,
  // but scrollIntoView also moves the user's viewport, so on a short buffer it
  // would yank them to the bottom of the feed unprompted. An extension that
  // moves the page is an extension the user stops trusting.
  //
  // So when there is no API to call, a round only proceeds if the sentinel is
  // already at the edge of the viewport -- i.e. the user has scrolled there
  // themselves. Otherwise we wait for the next tick and try the API again.
  function requestMoreFromYouTube() {
    const grid = document.querySelector("ytd-rich-grid-renderer");
    const app = document.querySelector("ytd-app");
    const api = (grid && grid.api) || (app && app.api);
    if (api) {
      for (const name of ["reloadContinuationItems", "handleAppendContinuationItemsAction"]) {
        if (typeof api[name] === "function") {
          try {
            api[name]();
            return true;
          } catch (error) {
            // Fall through to the next candidate.
          }
        }
      }
    }

    const sentinel = findFeedContinuation();
    if (!sentinel) return false;

    // Only act if the sentinel is already visible, so the IntersectionObserver
    // that triggers the fetch has been or is about to be satisfied without us
    // scrolling anything.
    const rect = sentinel.getBoundingClientRect ? sentinel.getBoundingClientRect() : null;
    if (!rect) return false;
    const withinView = rect.top < window.innerHeight && rect.bottom > 0;
    return withinView;
  }

  function runLookahead() {
    if (!lookaheadActive || lookaheadRunning) return;

    if (lookaheadDeadRounds >= LOOKAHEAD.maxDeadRounds) {
      stopFeedLookahead();
      return;
    }

    // Work only when the buffer below the fold is genuinely thin. This is the
    // check the old version had inverted: it demanded the user already be near
    // the bottom, which is the single moment lookahead can do nothing for them.
    if (feedBufferScreens() >= LOOKAHEAD.targetScreens) {
      lookaheadDeadRounds = 0;
      armLookaheadTimer();
      return;
    }

    // YouTube is already fetching. Never stack a second request on top.
    if (feedIsLoading()) {
      armLookaheadTimer();
      return;
    }

    // Minimum gap between requests, so this still cannot free-run.
    if (Date.now() - lookaheadLastRun < LOOKAHEAD.tickMs) {
      armLookaheadTimer();
      return;
    }

    if (!requestMoreFromYouTube()) {
      // No continuation element queued at all. Count it, but do not treat a
      // single miss as fatal -- YouTube rebuilds the sentinel while navigating.
      lookaheadDeadRounds += 1;
      armLookaheadTimer();
      return;
    }

    lookaheadRunning = true;
    lookaheadLastRun = Date.now();
    lookaheadRounds += 1;
    waitForFeedGrowth(countFeedItems());
  }

  // Polls until YouTube appends something or the settle window expires. One
  // check cannot distinguish a slow server from a real dead end, so this waits
  // and only then decides.
  function waitForFeedGrowth(before) {
    const deadline = Date.now() + LOOKAHEAD.settleMs;
    const poll = () => {
      // This timeout has fired; clear the slot so armLookaheadTimer can re-arm.
      lookaheadTimer = null;
      if (countFeedItems() > before) {
        // Real progress. Clear the dead counter so one bad round can never end
        // the feature for the whole page load.
        lookaheadDeadRounds = 0;
        lookaheadRunning = false;
        armLookaheadTimer();
        return;
      }
      if (Date.now() >= deadline) {
        // Only count it as dead when YouTube is neither loading nor offering a
        // continuation. Busy-but-slow must not be mistaken for finished.
        if (!feedIsLoading() && !findFeedContinuation()) {
          lookaheadDeadRounds += 1;
        }
        lookaheadRunning = false;
        armLookaheadTimer();
        return;
      }
      lookaheadTimer = window.setTimeout(poll, LOOKAHEAD.settlePollMs);
    };
    lookaheadTimer = window.setTimeout(poll, LOOKAHEAD.settlePollMs);
  }

  // --- Endless feed ---------------------------------------------------------
  // When YouTube runs out of continuation tokens on the home feed it does not
  // just stop: it renders a "Show more" button at the bottom of the grid.
  // Pressing that button makes YouTube fetch a fresh batch and render it with
  // its own renderers, which is exactly what an endless feed needs to be.
  //
  // So this presses the button YouTube already offers. That is deliberately the
  // whole implementation. The two previous attempts were worse:
  //
  //   * Reloading the page. It works, and the user hates it: a full reload to
  //     extend a list is a visible, jarring interruption that throws away
  //     everything the page was doing. Removed outright.
  //   * Appending cards built from InnerTube data. The data is obtainable --
  //     an authenticated browse returns real videos -- but the rendering is not.
  //     A hand-built <ytd-rich-item-renderer> is re-rendered by Polymer's own
  //     template and comes out blank, and the grid's own append handler is
  //     minified and routes through a command-keyed action map that silently
  //     ignores a raw parsed response. Depending on minified internals would
  //     break without warning.
  //
  // Pressing a button the user could have pressed themselves is stable, needs no
  // internal API, and cannot fabricate anything.
  const ENDLESS = {
    // Consider the feed finished once the buffer is this thin ...
    minBufferScreens: 1.5,
    // ... and has stayed that way this long before acting.
    settleQuietMs: 2500,
    // Never press more often than this.
    cooldownMs: 12000,
    // Give up on this page load after this many presses. YouTube only offers the
    // button when it genuinely has another batch; if pressing it stops producing
    // items, something is wrong and retrying forever would hammer the site.
    maxPresses: 30,
    // How long to wait for a pressed button to actually deliver items.
    settleMs: 8000,
    settlePollMs: 300
  };

  // What YouTube calls the reload affordance, across locales. Matched against a
  // normalised aria-label or button text, and only on buttons inside the feed's
  // continuation area, so an unrelated "More" elsewhere on the page is never hit.
  const ENDLESS_RELOAD_LABELS = [
    "show more", "load more", "more videos", "see more", "more",
    "показать ещё", "показать еще", "ещё", "еще",
    "загрузить ещё", "загрузить еще", "больше видео", "ещё видео"
  ];

  let endlessTimer = null;
  let endlessPresses = 0;
  let endlessEmptyPresses = 0;
  let endlessLastRun = 0;
  let endlessRunning = false;
  let statusTimer = null;

  function endlessFeedEnabled() {
    return Boolean(state.enabled && state.settings.endlessFeed);
  }

  function resetEndlessFeed() {
    if (endlessTimer) {
      clearTimeout(endlessTimer);
      endlessTimer = null;
    }
    endlessPresses = 0;
    endlessEmptyPresses = 0;
    endlessLastRun = 0;
    endlessRunning = false;
  }

  function stopEndlessFeed() {
    if (endlessTimer) {
      clearTimeout(endlessTimer);
      endlessTimer = null;
    }
    clearFeedStatus();
  }

  // A short, unobtrusive note in the corner. Never silent: if the feed genuinely
  // cannot be extended, the user is told rather than left with a dead end.
  function showFeedStatus(text, sticky) {
    let el = document.getElementById("ff-feed-status");
    if (!el) {
      el = document.createElement("div");
      el.id = "ff-feed-status";
      (document.body || document.documentElement).appendChild(el);
    }
    el.textContent = text;
    el.setAttribute("data-ff-visible", "1");
    if (statusTimer) {
      clearTimeout(statusTimer);
      statusTimer = null;
    }
    if (!sticky) {
      statusTimer = window.setTimeout(() => {
        if (el.isConnected) el.removeAttribute("data-ff-visible");
      }, 4000);
    }
  }

  function clearFeedStatus() {
    const el = document.getElementById("ff-feed-status");
    if (el) el.remove();
    if (statusTimer) {
      clearTimeout(statusTimer);
      statusTimer = null;
    }
  }

  // YouTube has genuinely stopped: thin buffer, no continuation element queued,
  // and no spinner saying it is still working.
  function feedIsExhausted() {
    if (feedBufferScreens() > ENDLESS.minBufferScreens) return false;
    if (findFeedContinuation()) return false;
    if (feedIsLoading()) return false;
    return true;
  }

  // Finds YouTube's own "Show more" button.
  //
  // Scoped to the continuation area on purpose. A loose text match anywhere on
  // the page would eventually hit an unrelated control labelled "More" and click
  // something the user never asked to click -- the exact class of bug that makes
  // an extension feel like it is taking over the browser.
  function findFeedReloadButton() {
    const scopes = [
      "ytd-continuation-item-renderer",
      "#continuations",
      "ytd-rich-grid-renderer #continuations",
      "ytd-rich-grid-renderer"
    ];
    const seen = new Set();
    for (const scope of scopes) {
      document.querySelectorAll(scope).forEach((root) => {
        if (seen.has(root)) return;
        seen.add(root);
        const buttons = root.querySelectorAll(
          "button, ytd-button-renderer, [role='button'], a[href='#'], a[role='button']"
        );
        buttons.forEach((button) => {
          if (seen.has(button)) return;
          seen.add(button);
          if (button.disabled || button.hasAttribute("disabled") || button.getAttribute("aria-disabled") === "true") return;
          if (!button.isConnected) return;
          const raw =
            button.getAttribute("aria-label") ||
            button.getAttribute("title") ||
            button.innerText ||
            button.textContent ||
            "";
          const label = String(raw).replace(/\s+/g, " ").trim().toLowerCase();
          if (!label || label.length > 40) return;
          if (ENDLESS_RELOAD_LABELS.some((t) => label === t || label.startsWith(t))) {
            found.button = button;
          }
        });
      });
      if (found.button) break;
    }
    return found.button;
  }

  const found = { button: null };

  function scheduleEndlessRecovery() {
    if (!endlessFeedEnabled() || endlessRunning) return;
    // Home feed only. A channel or subscriptions page may legitimately end, and
    // pressing a button there would be wrong. This also means the extension can
    // never act while the user is watching something.
    if (location.pathname !== "/") return;
    if (endlessPresses >= ENDLESS.maxPresses) return;
    if (endlessEmptyPresses >= 3) return;
    if (endlessTimer) return;
    const wait = Math.max(ENDLESS.settleQuietMs, ENDLESS.cooldownMs - (Date.now() - endlessLastRun));
    endlessTimer = window.setTimeout(() => {
      endlessTimer = null;
      pressFeedReloadButton();
    }, wait);
  }

  function pressFeedReloadButton() {
    if (!endlessFeedEnabled() || endlessRunning) return;
    if (endlessPresses >= ENDLESS.maxPresses) return;
    if (!feedIsExhausted()) return;

    found.button = null;
    const button = findFeedReloadButton();
    if (!button) {
      // YouTube offered nothing to press. Say so once and stop, rather than
      // reloading the page or hammering the site.
      endlessEmptyPresses += 1;
      if (endlessEmptyPresses >= 2) {
        showFeedStatus("YouTube не даёт продолжить ленту", true);
      }
      return;
    }

    endlessRunning = true;
    endlessLastRun = Date.now();
    endlessPresses += 1;

    const before = countFeedItems();
    showFeedStatus("Лента обновляется…");

    // YouTube issues the request and renders the result. We only press the button.
    try {
      button.click();
    } catch (error) {
      endlessRunning = false;
      endlessEmptyPresses += 1;
      return;
    }

    const deadline = Date.now() + ENDLESS.settleMs;
    const poll = () => {
      const after = countFeedItems();
      if (after > before) {
        endlessEmptyPresses = 0;
        endlessRunning = false;
        clearFeedStatus();
        // Top up again if there is still not enough below the fold.
        if (feedIsExhausted() || feedBufferScreens() < LOOKAHEAD.targetScreens) {
          scheduleEndlessRecovery();
        }
        return;
      }
      if (Date.now() >= deadline) {
        // The button produced nothing. Stop after a couple of attempts instead
        // of pressing forever.
        endlessEmptyPresses += 1;
        endlessRunning = false;
        if (endlessEmptyPresses >= 2) {
          showFeedStatus("YouTube не даёт продолжить ленту", true);
        } else {
          clearFeedStatus();
          scheduleEndlessRecovery();
        }
        return;
      }
      window.setTimeout(poll, ENDLESS.settlePollMs);
    };
    window.setTimeout(poll, ENDLESS.settlePollMs);
  }

  function connectHome() {
    if (!isFilterSurface() || !state.enabled || isShortsPlayerPage()) {
      disconnectHome();
      return;
    }
    homeActive = true;
    if (!homeObserver && document.documentElement) {
      // childList only: attribute changes are not what we react to, and
      // observing them would make the observer fire on our own mutations.
      homeObserver = new MutationObserver(onHomeMutations);
      homeObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
    scheduleHomeScan();
  }

  // Runs synchronously as soon as nodes are inserted. Cards are marked pending
  // here so they never paint, then the debounced scan settles them.
  function onHomeMutations(mutations) {
    if (!homeActive || !state.enabled || isShortsPlayerPage()) {
      return;
    }
    let sawNewCards = false;
    for (const mutation of mutations) {
      if (mutation.addedNodes && mutation.addedNodes.length) {
        for (const node of mutation.addedNodes) {
          if (!node || node.nodeType !== 1) {
            continue;
          }
          if (node.matches && node.matches(CARD_SELECTOR)) {
            markCardPending(node);
            sawNewCards = true;
          }
          // A card is usually inserted inside a wrapper, so scan one level in.
          if (node.querySelectorAll) {
            const nested = node.querySelectorAll(CARD_SELECTOR);
            if (nested.length) {
              nested.forEach((card) => markCardPending(card));
              sawNewCards = true;
            }
          }
        }
      }
    }
    if (sawNewCards) {
      scheduleHomeScan();
      schedulePrefetch();
    } else {
      scheduleHomeScan();
    }
  }

  function updatePageMode() {
    // A navigation is a new feed: reset the lookahead budget.
    resetFeedLookahead();
    resetEndlessFeed();
    if (isFilterSurface()) {
      connectHome();
    } else {
      disconnectHome();
    }
    if (isSubscriptionListPage() && state.syncFallback) {
      startFallbackSync();
    }
    // The three-dot "Blacklist" action is useful on every YouTube page that
    // shows videos, including channel pages and the Shorts feed. The player
    // settings menu is filtered out later by findOpenMenu().
    if (state.enabled) {
      installVideoMenuObserver();
    }
    if (location.pathname.startsWith("/watch") || isFilterSurface()) {
      scheduleDynamicCheck();
    }

    function installVideoMenuObserver() {
      if (videoMenuObserver || !document.documentElement) return;
      let menuTimer = null;
      videoMenuObserver = new MutationObserver(() => {
        if (menuTimer) return;
        menuTimer = setTimeout(() => {
          menuTimer = null;
          injectVideoBlockMenuItem();
        }, 50);
      });
      videoMenuObserver.observe(document.documentElement, { childList: true, subtree: true });
      injectVideoBlockMenuItem();
    }

    function createBlockMenuItem(channel, card) {
      const item = document.createElement("tp-yt-paper-item");
      item.setAttribute("data-ff-video-block-channel", "1");
      item.setAttribute("role", "menuitem");
      item.setAttribute("aria-label", "Blacklist channel");
      const isWatchMenu = location.pathname.startsWith("/watch");
      if (isWatchMenu) {
        item.setAttribute("data-ff-watch-menu", "1");
      }
      item.style.cssText = "display:flex;align-items:center;box-sizing:border-box;width:100%;max-width:100%;min-width:0;min-height:48px;padding:0 16px;visibility:visible;opacity:1;color:inherit;cursor:pointer;overflow:hidden";
      const icon = document.createElement("span");
      icon.setAttribute("aria-hidden", "true");
      icon.style.cssText = "margin-right:16px;width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;color:inherit";
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("width", "24");
      svg.setAttribute("height", "24");
      svg.setAttribute("aria-hidden", "true");
      svg.style.cssText = "display:block;width:24px;height:24px;fill:currentColor";
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("fill", "currentColor");
      path.setAttribute("d", "M5 3a1 1 0 0 1 1-1h12a1 1 0 0 1 .8 1.6L15.25 8l3.55 4.4A1 1 0 0 1 18 14H7v7H5V3Zm2 2v7h8.9l-2.75-3.4a1 1 0 0 1 0-1.2L15.9 5H7Z");
      svg.appendChild(path);
      icon.appendChild(svg);
      const label = document.createElement("span");
      label.id = "label";
      label.style.cssText = "display:block;flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;visibility:visible;opacity:1;color:inherit;font:inherit;white-space:nowrap";
      label.textContent = "Blacklist";
      item.append(icon, label);
      item.addEventListener("click", () => {
        addBlockedChannel(channel, card);
        item.remove();
      });
      return item;
    }

    function injectVideoBlockMenuItem() {
      document.querySelectorAll(
        ".ytp-panel-menu [data-ff-video-block-channel], " +
        ".ytp-settings-menu [data-ff-video-block-channel]"
      ).forEach((item) => item.remove());
      const menu = findOpenMenu();
      if (!menu) return;
      if (menu.querySelector("[data-ff-video-block-channel]")) {
        expandInjectedMenu(menu);
        return;
      }
      // Watch pages: the open menu belongs to the video currently playing, so
      // the channel comes from the video owner block.
      if (location.pathname.startsWith("/watch")) {
        const channel = ownerChannel();
        if (hasChannelData(channel)) {
          menu.appendChild(createBlockMenuItem(channel, null));
          expandInjectedMenu(menu);
        }
        return;
      }
      // Everywhere else (home, search, channel pages, playlists, Shorts feed)
      // the channel comes from the card whose three-dot button was clicked.
      const context = lastMenuContext && Date.now() - lastMenuContext.at < 10000
        ? lastMenuContext
        : findOpenFeedCardContext();
      if (!context) return;
      const card = context.card;
      const channel = context.channel && hasChannelData(context.channel)
        ? context.channel
        : extractChannel(card);
      if (card && hasChannelData(channel)) {
        menu.appendChild(createBlockMenuItem(channel, card));
        expandInjectedMenu(menu);
      }
    }

    function expandInjectedMenu(menu) {
      if (menu.closest(".ytp-panel-menu, .ytp-settings-menu")) return;
      const containers = [
        menu,
        menu.closest("ytd-menu-popup-renderer"),
        menu.closest("yt-sheet-view-model"),
        menu.closest("yt-contextual-sheet-layout"),
        menu.closest("tp-yt-iron-dropdown")
      ].filter(Boolean);
      containers.forEach((container) => {
        container.style.maxHeight = "none";
        container.style.height = "auto";
        container.style.overflow = "hidden";
        container.style.overflowX = "hidden";
        container.style.overflowY = "hidden";
      });
    }

    function findOpenFeedCardContext() {
      const card = Array.from(document.querySelectorAll(CARD_SELECTOR)).reverse().find((candidate) => {
        return candidate.querySelector(
          "button[aria-expanded='true'], " +
          "[aria-expanded='true'][role='button'], " +
          "ytd-menu-button-renderer[opened], ytd-menu-button-renderer[aria-expanded='true']"
        );
      });
      return card ? { card, channel: extractChannel(card), at: Date.now() } : null;
    }

    function findOpenMenu() {
      const candidates = document.querySelectorAll(
        "ytd-menu-popup-renderer #items, " +
        "ytd-menu-popup-renderer tp-yt-paper-listbox, " +
        "ytd-popup-container ytd-menu-popup-renderer, " +
        "[role='menu'], tp-yt-paper-listbox"
      );
      return Array.from(candidates).reverse().find((element) => {
        const rect = element.getBoundingClientRect();
        const isPlayerSettingsMenu = element.closest(
          ".ytp-panel-menu, .ytp-settings-menu"
        );
        return rect.width > 0 && rect.height > 0 && !isPlayerSettingsMenu;
      }) || null;
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

  function isMoreMenuTrigger(element) {
    if (!element || !element.closest) return false;
    const button = element.closest("button, yt-icon-button, ytd-menu-button-renderer, ytd-menu-renderer");
    if (!button) return false;
    const text = menuText(button);
    return text === "more" ||
      text === "ещё" ||
      text === "действия" ||
      text.includes("more actions") ||
      text.includes("дополнительные действия");
  }

  function observeNotInterestedAction(event) {
    const target = event.target && event.target.closest
      ? event.target.closest("ytd-menu-service-item-renderer, tp-yt-paper-item, [role='menuitem']")
      : null;
    const card = cardForElement(event.target);
    if (card && isMoreMenuTrigger(event.target)) {
      lastMenuContext = { card, channel: extractChannel(card), at: Date.now() };
      setTimeout(() => {
        if (isFilterSurface() || state.enabled) {
          updatePageMode();
        }
      }, 0);
    }
    if (!target || !isNotInterestedItem(target)) {
      return;
    }
    // "Not interested" is a strong signal: blacklist the channel on every
    // surface, including channel pages and the Shorts feed.
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

  // Union of two channel states. Used when a partial result has to be combined
  // with what is already stored, so an incomplete fetch can only ever add
  // coverage and never shrink the list.
  function unionChannelState(a, b) {
    const left = a && typeof a === "object" ? a : {};
    const right = b && typeof b === "object" ? b : {};
    const pick = (key) => [].concat(left[key] || [], right[key] || []).filter(Boolean);
    return normalizeChannelState({
      ids: pick("ids"),
      handles: pick("handles"),
      customUrls: pick("customUrls"),
      names: pick("names"),
      records: [].concat(left.records || [], right.records || [])
    });
  }

  // InnerTube's SAPISIDHASH scheme. This WORKS from a page script, and that is
  // by design: the whole point of the scheme is that web pages can authenticate
  // their own InnerTube calls.
  //
  // An earlier version of this file claimed SAPISID was HttpOnly and therefore
  // unobtainable. That was wrong, and the mistake was expensive: it was derived
  // from a probe made in a signed-out session, where SAPISID was simply absent
  // from the cookie jar, and "absent" was read as "HttpOnly". Measured while
  // signed in, the jar does expose SAPISID / __Secure-3PAPISID, and an
  // authenticated browse returns real data where an anonymous one returns an
  // empty shell.
  async function authorizationHeader() {
    const item = document.cookie
      .split("; ")
      .find((entry) => entry.startsWith("SAPISID=") || entry.startsWith("__Secure-3PAPISID="));
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
    if (apiKey && clientVersion) {
      // Page through whatever the embedded document did not include. This runs
      // entirely in the background: it is a fetch, it never navigates the tab,
      // and the user is never asked to go anywhere.
      //
      // The Authorization header is what makes this work. Without it YouTube
      // answers with an empty shell and every page is a wasted round-trip.
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
      const clientCtx = { clientName: "WEB", clientVersion };
      const visitorData = htmlValue(html, "VISITOR_DATA");
      if (visitorData) clientCtx.visitorData = visitorData;

      let round = 0;
      let skippedPages = 0;
      let grew = 0;
      onProgress({ count: result.channels.size, round, skippedPages });

      while (result.tokens.size && round < 60) {
        const token = result.tokens.values().next().value;
        result.tokens.delete(token);
        let pageData = null;
        try {
          const response = await fetchWithTimeout(
            "https://www.youtube.com/youtubei/v1/browse?key=" + encodeURIComponent(apiKey) + "&prettyPrint=false",
            {
              method: "POST",
              credentials: "include",
              headers,
              body: JSON.stringify({ context: { client: clientCtx }, continuation: token })
            },
            10000
          );
          if (response.ok) {
            pageData = await response.json();
          } else {
            skippedPages += 1;
          }
        } catch (error) {
          skippedPages += 1;
        }

        if (pageData) {
          const page = { channels: new Map(), tokens: new Set() };
          collectSubscriptionData(pageData, page, 0);
          page.channels.forEach((channel, id) => {
            const known = result.channels.get(id);
            if (!known || (!known.handle && channel.handle)) {
              result.channels.set(id, channel);
              grew += 1;
            }
          });
          // Only follow continuationCommand tokens. The embedded document also
          // carries unrelated "token" strings (for chips, menus and similar);
          // treating those as continuations sends the loop after garbage.
          page.tokens.forEach((pageToken) => result.tokens.add(pageToken));
        }

        round += 1;
        onProgress({ count: result.channels.size, round, skippedPages });
        // Stop as soon as two consecutive pages add nothing. That is YouTube
        // saying it has nothing more, not a transient hiccup.
        if (grew === 0 && round > 2) break;
      }
      result.skippedPages = skippedPages;
    }

    // Partial means: YouTube still had continuation tokens queued and we ran out
    // of rounds anyway. It must NOT be inferred from "tokens exist" alone -- the
    // subscriptions page carries unrelated token strings, and treating those as
    // unfinished work is what made the extension cry wolf.
    const partial = result.tokens.size > 0 && (result.skippedPages || 0) > 0;

    onProgress({ count: result.channels.size, round: 0, skippedPages: result.skippedPages || 0 });
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
    partial,
    skippedPages: result.skippedPages || 0
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

      // An incomplete batch must not overwrite a complete list. Merge it into
      // what is already stored so coverage only ever grows.
      //
      // The user is NEVER told to go visit a page. Synchronisation is a
      // background operation and it stays one: an earlier version ended an
      // incomplete sync with "open your subscriptions page once", which pushed
      // the work back onto the user and read as the extension hijacking their
      // tab. If the list is short, FreshFeed retries on its own schedule and
      // tops up opportunistically from the subscriptions page only if the user
      // happens to already be there.
      if (channels.partial) {
        const merged = unionChannelState(state.channels, channels);
        const mergedTotal = channelCount(merged);
        const syncedAt = Date.now();
        state.channels = merged;
        state.syncedAt = syncedAt;
        state.syncPending = true;
        // Only ask for the DOM harvest when the list is implausibly short for a
        // real account, and even then it is armed silently: it runs by itself if
        // and when the user is on the page, and is never requested of them.
        state.syncFallback = mergedTotal < IMPLAUSIBLY_FEW_CHANNELS;
        state.syncProgress = null;
        updateSets();
        const note = "Synchronized " + mergedTotal + " channels. Some pages were unavailable, " +
          "so FreshFeed will keep retrying in the background.";
        await browser.storage.local.set({
          channels: merged,
          syncedAt,
          initialSyncDone: true,
          syncPending: true,
          syncFallback: state.syncFallback,
          syncProgress: null,
          lastSyncResult: note
        });
        showOverlay("FreshFeed: " + mergedTotal + " channels, retrying in background", false);
        removeOverlayLater();
        return;
      }

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
      // NEVER navigate the user's tab. The subscription list is fetched and
      // parsed entirely in the background; if the API route fails we retry the
      // page route here rather than sending the user to /feed/channels.
      let recovered = false;
      try {
        const fallbackChannels = await fetchSubscriptionsFromPage();
        const total = channelCount(fallbackChannels);
        if (total > 0) {
          const syncedAt = Date.now();
          state.channels = fallbackChannels;
          state.syncedAt = syncedAt;
          state.syncPending = false;
          state.syncFallback = false;
          state.syncProgress = null;
          updateSets();
          await browser.storage.local.set({
            channels: fallbackChannels,
            syncedAt,
            initialSyncDone: true,
            syncPending: false,
            syncFallback: false,
            syncProgress: null,
            lastSyncResult: "Synchronized " + total + " channels (background fallback) in " +
              Math.floor((syncedAt - startedAt) / 1000) + "s"
          });
          showOverlay("FreshFeed: ready, " + total + " channels", false);
          removeOverlayLater();
          recovered = true;
        }
      } catch (fallbackError) {
        // Fall through to reporting the original failure below.
      }
      if (!recovered) {
        await browser.storage.local.set({
          syncPending: false,
          syncProgress: null,
          syncFallback: false,
          lastSyncResult: "Sync failed: " + message +
            ". FreshFeed will retry later; your feed keeps working with the channels already saved."
        });
        showOverlay("FreshFeed: sync failed, will retry", false);
        removeOverlayLater();
      }
    } finally {
      syncRunning = false;
    }
  }

  // Fetches and parses the subscriptions page WITHOUT navigating to it. The
  // page HTML is a plain fetch, so the user never leaves what they were doing.
  async function fetchSubscriptionsFromPage() {
    const response = await fetchWithTimeout(
      "https://www.youtube.com/feed/channels",
      { credentials: "include" },
      10000
    );
    if (!response.ok) {
      throw new Error("subscription page unavailable (" + response.status + ")");
    }
    const html = await response.text();
    const initialData = extractJsonObject(html, "ytInitialData");
    if (!initialData) {
      throw new Error("subscription page had no data");
    }
    const collected = { channels: new Map(), tokens: new Set() };
    collectSubscriptionData(initialData, collected, 0);
    const channels = { ids: [], handles: [], customUrls: [], names: [] };
    collected.channels.forEach((channel) => {
      channels.ids.push(channel.id);
      if (channel.handle) channels.handles.push(channel.handle);
      if (channel.customUrl) channels.customUrls.push(channel.customUrl);
      if (channel.name) channels.names.push(channel.name);
    });
    const normalized = normalizeChannelState(channels);
    if (!normalized.ids.length) {
      throw new Error("no subscriptions found in the page");
    }
    return normalized;
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
    if (fallbackRunning || !isSubscriptionListPage() || !state.syncFallback) {
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
    // Union with what is already stored: this pass may legitimately see fewer
    // channels than a previous one (a lazy page, a changed layout), and the
    // stored list must never shrink because of it.
    const merged = unionChannelState(state.channels, channels);
    const total = channelCount(merged);
    const values = total > 0 ? merged : state.channels;
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
    // YouTube puts data-channel-id / data-channel-handle on the channel *link*
    // or on a descendant, not necessarily on the root element itself. Check the
    // root and every descendant so a subscribe button with no direct link still
    // resolves to a channel.
    root.querySelectorAll("[data-channel-id]").forEach((element) => {
      const id = element.getAttribute("data-channel-id");
      if (/^UC[\w-]+$/i.test(id || "")) {
        result.ids.add(id.toLowerCase());
      }
    });
    root.querySelectorAll("[data-channel-handle]").forEach((element) => {
      const handle = normName(element.getAttribute("data-channel-handle"));
      if (handle) {
        result.handles.add(handle.startsWith("@") ? handle : "@" + handle);
      }
    });
    // Collect every channel link, not just the first one: a card contains the
    // avatar link, the title link and the @handle link, and they differ.
    const links = root.querySelectorAll("a[href]");
    const hrefs = [
      root.getAttribute("href"),
      root.getAttribute("data-channel-id"),
      root.getAttribute("data-channel-handle"),
      ...Array.from(links, (link) => link.getAttribute("href"))
    ].filter(Boolean);
    for (const href of hrefs) {
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
    }
    // The display name lives in several possible places depending on the
    // surface; try each rather than only the first two.
    const nameSelectors = [
      "#text",
      "yt-formatted-string#text",
      "yt-formatted-string",
      "ytd-channel-name #text",
      "#channel-name #text",
      ".yt-core-attributed-string"
    ];
    for (const selector of nameSelectors) {
      const element = root.querySelector(selector);
      const value = normName(element && (element.textContent || element.getAttribute("title")));
      if (value && value.length < 160) {
        result.names.add(value);
        break;
      }
    }
    return result;
  }

  async function syncFromSubscribeButton(button) {
    if (!button) {
      return;
    }
    let channel = ownerChannel();
    const root = button.closest("ytd-channel-renderer, yt-channel-header-renderer, ytd-video-owner-renderer, yt-channel-header-view-model, ytd-c4-tabbed-header-renderer");
    if (root) {
      const fromRoot = readChannelFromRoot(root);
      if (hasChannelData(fromRoot)) {
        channel = fromRoot;
      }
    }
    if (!hasChannelData(channel)) {
      // The subscribe button often sits in a wrapper that has no channel link
      // of its own, so walk up a few levels to find the enclosing card/header.
      let scope = button;
      for (let depth = 0; depth < 8 && scope; depth += 1) {
        scope = scope.parentElement;
        if (!scope) break;
        const found = readChannelFromRoot(scope);
        if (hasChannelData(found)) {
          channel = found;
          break;
        }
      }
    }
    if (!hasChannelData(channel)) {
      return;
    }
    const subscribeRoot = button.closest("ytd-subscribe-button-renderer, yt-subscribe-button-view-model");
    // Read the button state from every place YouTube expresses it. Immediately
    // after a click the attributes may not have flipped yet, so this also
    // consults the parent renderer and the button label text.
    const label = normName(button.textContent || button.getAttribute("aria-label") || "");
    const subscribed =
      button.getAttribute("aria-pressed") === "true" ||
      button.hasAttribute("subscribed") ||
      Boolean(subscribeRoot && (subscribeRoot.hasAttribute("subscribed") || subscribeRoot.getAttribute("subscribe-button-type") === "SUBSCRIBED")) ||
      label === "subscribed" ||
      label === "\u0432\u044b \u043f\u043e\u0434\u043f\u0438\u0441\u0430\u043d\u044b" ||
      label.includes("unsubscribe") ||
      label.includes("\u043e\u0442\u043f\u0438\u0441\u0430\u0442\u044c\u0441\u044f");
    const result = mergeChannel(channel, !subscribed);
    if (result.changed) {
      state.channels = result.channels;
      updateSets();
      await browser.storage.local.set({ channels: state.channels });
      // The card may still be on screen (channel page, watch sidebar), so
      // re-evaluate what is visible right away instead of waiting for a scan.
      if (homeActive) {
        clearHiddenCards(true);
        scheduleHomeScan();
      }
    }
  }

  // The subscribe button flips its state asynchronously, so one sample right
  // after the click can read the old value. Poll briefly and apply the result
  // as soon as the button reports the new state.
  function watchSubscribeButton(button) {
    let attempts = 0;
    const tick = () => {
      attempts += 1;
      syncFromSubscribeButton(button).then(() => {
        // Re-read after the update so a late attribute change is not missed.
        if (attempts < 12) {
          setTimeout(tick, 250);
        }
      });
    };
    setTimeout(tick, 150);
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
      clearHiddenCards(true);
      updatePageMode();
    }
    if (changes.blockedChannels) {
      state.blockedChannels = normalizeChannelState(changes.blockedChannels.newValue);
      updateSets();
      clearHiddenCards(true);
      updatePageMode();
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
      if (state.syncFallback && isSubscriptionListPage()) {
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
    // The options page asks the active YouTube tab to sync immediately. This
    // runs the sync here, in the background, so nothing is ever opened or
    // navigated on the user's behalf.
    try {
      if (browser.runtime && browser.runtime.onMessage) {
        browser.runtime.onMessage.addListener((message) => {
          if (message && message.type === "freshfeed-run-sync") {
            runPrimarySync(true);
          }
        });
      }
    } catch (error) {
      // Older hosts may not expose onMessage; the storage flag still works.
    }
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
      // The button state changes asynchronously, so poll it instead of sampling
      // once, which is what made a fresh subscribe miss the list.
      watchSubscribeButton(button);
    }, true);
    document.addEventListener("click", observeNotInterestedAction, true);
    updatePageMode();
    if (state.syncFallback && isSubscriptionListPage()) {
      startFallbackSync();
    } else if (state.syncPending) {
      maybeStartSync();
    }
  }

  init();
}());

