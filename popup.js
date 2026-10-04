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
    endlessFeed: document.getElementById("endless-feed"),
    feedLookahead: document.getElementById("feed-lookahead"),
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
  const uploadDateOptions = document.getElementById("upload-date-options");
  const durationOptions = document.getElementById("duration-options");
  const uploadDateBetween = document.getElementById("upload-date-between");
  const durationBetween = document.getElementById("duration-between");
  const error = document.getElementById("error");
  const settingsButton = document.getElementById("settings");
  const enabledControl = document.getElementById("enabled");

  async function refresh() {
    const data = await browser.storage.local.get([...Object.keys(settingControls), "enabled", "lastSyncResult"]);
    const settings = { ...defaults, ...data };
    enabledControl.checked = data.enabled !== false;
    Object.entries(settingControls).forEach(([key, control]) => {
      control.checked = settings[key] === true;
    });
    // The whole form is inert while the master switch is off, which makes the
    // popup's state readable at a glance.
    document.body.classList.toggle("disabled", !enabledControl.checked);
    Object.entries(numericControls).forEach(([key, control]) => {
      control.value = Number(settings[key]) || (key.includes("Min") ? 1 : key.includes("Date") ? 30 : 60);
    });
    Object.entries(selectControls).forEach(([key, control]) => {
      control.value = settings[key];
    });
    uploadDateOptions.hidden = !settings.filterUploadDate;
    durationOptions.hidden = !settings.filterDuration;
    uploadDateBetween.hidden = settings.uploadDateMode !== "between";
    durationBetween.hidden = settings.durationMode !== "between";
    document.querySelector(".unit-label").textContent = settings.uploadDateUnit;
    document.querySelector(".duration-unit-label").textContent = settings.durationUnit;
    const message = typeof data.lastSyncResult === "string" && data.lastSyncResult.startsWith("Sync failed:")
      ? data.lastSyncResult
      : "";
    error.hidden = !message;
    error.textContent = message;
  }

  Object.entries(settingControls).forEach(([key, control]) => {
    control.addEventListener("change", () => browser.storage.local.set({ [key]: control.checked }).then(refresh));
  });
  Object.entries(numericControls).forEach(([key, control]) => {
    control.addEventListener("change", () => {
      const value = Math.max(Number(control.min), Math.min(Number(control.max), Number(control.value) || Number(control.min)));
      control.value = value;
      browser.storage.local.set({ [key]: value }).then(refresh);
    });
  });
  Object.entries(selectControls).forEach(([key, control]) => {
    control.addEventListener("change", () => browser.storage.local.set({ [key]: control.value }).then(refresh));
  });
  enabledControl.addEventListener("change", () => browser.storage.local.set({ enabled: enabledControl.checked }).then(refresh));
  settingsButton.addEventListener("click", () => browser.runtime.openOptionsPage());
  browser.storage.onChanged.addListener(refresh);
  refresh();
}());
