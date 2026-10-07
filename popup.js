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
    endlessFeed: document.getElementById("endless-feed"),
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
  const uploadDateOptions = document.getElementById("upload-date-options");
  const durationOptions = document.getElementById("duration-options");
  const uploadDateBetween = document.getElementById("upload-date-between");
  const durationBetween = document.getElementById("duration-between");
  const uploadDateFilterValue = document.getElementById("upload-date-filter-value");
  const durationFilterValue = document.getElementById("duration-filter-value");
  const error = document.getElementById("error");
  const settingsButton = document.getElementById("settings");
  const enabledControl = document.getElementById("enabled");
  const masterLabel = document.getElementById("master-label");
  const allTrash = document.getElementById("block-all-trash");
  // Settings that "Block All Trash" switches on at once. These are the three
  // categories above it (Channels, Content types, Promoted & generated blocks).
  const TRASH_KEYS = [
    "hideSubscribedChannels",
    "hideBlacklisted",
    "hideShorts",
    "hidePlayables",
    "hideMembersOnly",
    "hideMixRadio",
    "hideLiveStreams",
    "hideCommunityPosts",
    "hideStorefrontShelves",
    "hidePromoShelves",
    "hideSurveys",
    "hideTopicShelves",
    "hideGeneratedShelves"
  ];

  async function refresh() {
    const data = await browser.storage.local.get([...Object.keys(settingControls), "enabled", "lastSyncResult"]);
    const settings = { ...defaults, ...data };
    enabledControl.checked = data.enabled !== false;
    if (masterLabel) {
      masterLabel.textContent = enabledControl.checked ? "ON" : "OFF";
      masterLabel.style.color = enabledControl.checked ? "green" : "red";
      masterLabel.style.fontWeight = "bold";
    }
    Object.entries(settingControls).forEach(([key, control]) => {
      control.checked = settings[key] === true;
    });
    // "Block All Trash" is a live aggregate: it reads as ON while every trash
    // setting is enabled, and clears itself automatically if the user turns any
    // one of them off. It is a convenience switch, not a stored setting.
    allTrash.checked = TRASH_KEYS.every((key) => settings[key] === true);
    // The whole form is inert while the master switch is off, which makes the
    // popup's state readable at a glance.
    document.body.classList.toggle("disabled", !enabledControl.checked);
    Object.entries(numericControls).forEach(([key, control]) => {
      // Never stomp the field the user is actively editing; another refresh
      // racing the write could otherwise snap it back to the stored value.
      if (control === document.activeElement) return;
      control.value = Number(settings[key]) || (key.includes("Min") ? 1 : key.includes("Date") ? 30 : 60);
    });
    Object.entries(selectControls).forEach(([key, control]) => {
      // Same guard: a mode dropdown the user just opened/clicked must not be
      // reverted while we re-read storage.
      if (control === document.activeElement) return;
      control.value = settings[key];
    });
    uploadDateOptions.hidden = !settings.filterUploadDate;
    durationOptions.hidden = !settings.filterDuration;
    // Show only the inputs that match the selected mode. Both "Only past" and
    // "Block older than" use a single threshold value ("Value" row); only
    // "Between" switches to the two-bound "From..to" range row.
    uploadDateFilterValue.hidden = !(
      settings.filterUploadDate && settings.uploadDateMode !== "between"
    );
    uploadDateBetween.hidden = !(
      settings.filterUploadDate && settings.uploadDateMode === "between"
    );
    // Duration: "Only shorter than" and "Block longer than" use a single value;
    // "Between" uses the two-bound range row.
    durationFilterValue.hidden = !(
      settings.filterDuration && settings.durationMode !== "between"
    );
    durationBetween.hidden = !(
      settings.filterDuration && settings.durationMode === "between"
    );
    document.querySelector(".unit-label").textContent = settings.uploadDateUnit;
    document.querySelector(".duration-unit-label").textContent = settings.durationUnit;
    const message = typeof data.lastSyncResult === "string" && data.lastSyncResult.startsWith("Sync failed:")
      ? data.lastSyncResult
      : "";
    error.hidden = !message;
    error.textContent = message;
  }

  Object.entries(settingControls).forEach(([key, control]) => {
    control.addEventListener("change", () => browser.storage.local.set({ [key]: control.checked }));
  });
  Object.entries(numericControls).forEach(([key, control]) => {
    control.addEventListener("change", () => {
      const value = Math.max(Number(control.min), Math.min(Number(control.max), Number(control.value) || Number(control.min)));
      control.value = value;
      browser.storage.local.set({ [key]: value });
    });
  });
  Object.entries(selectControls).forEach(([key, control]) => {
    control.addEventListener("change", () => browser.storage.local.set({ [key]: control.value }));
  });
  enabledControl.addEventListener("change", () => browser.storage.local.set({ enabled: enabledControl.checked }));
  allTrash.addEventListener("change", () => {
    // Bulk action, not a toggle: flip every trash setting to match the switch.
    const patch = {};
    TRASH_KEYS.forEach((key) => { patch[key] = allTrash.checked; });
    browser.storage.local.set(patch).then(refresh);
  });
  settingsButton.addEventListener("click", () => browser.runtime.openOptionsPage());
  browser.storage.onChanged.addListener(refresh);
  refresh();
}());

