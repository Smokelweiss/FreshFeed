(function () {
  "use strict";

  const settingControls = {
    hideSubscribedChannels: document.getElementById("hide-subscribed"),
    hideShorts: document.getElementById("hide-shorts"),
    hidePlayables: document.getElementById("hide-playables"),
    hideMembersOnly: document.getElementById("hide-members-only"),
    hideMixRadio: document.getElementById("hide-mix-radio"),
    filterUploadDate: document.getElementById("filter-upload-date"),
    filterDuration: document.getElementById("filter-duration")
  };
  const error = document.getElementById("error");
  const settingsButton = document.getElementById("settings");

  async function refresh() {
    const data = await browser.storage.local.get([...Object.keys(settingControls), "lastSyncResult"]);
    Object.entries(settingControls).forEach(([key, control]) => {
      control.checked = data[key] !== false;
    });
    const message = typeof data.lastSyncResult === "string" && data.lastSyncResult.startsWith("Sync failed:")
      ? data.lastSyncResult
      : "";
    error.hidden = !message;
    error.textContent = message;
  }

  Object.entries(settingControls).forEach(([key, control]) => {
    control.addEventListener("change", () => browser.storage.local.set({ [key]: control.checked }));
  });
  settingsButton.addEventListener("click", () => browser.runtime.openOptionsPage());
  browser.storage.onChanged.addListener(refresh);
  refresh();
}());
