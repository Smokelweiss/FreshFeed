# Not Interested Capture and Feature Toggles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve YouTube's native “Not interested” action while adding its channel to FreshFeed's separate blacklist, and replace the cluttered popup with independent feature switches.

**Architecture:** Keep YouTube's menu event native by observing menu labels and card context in the capture phase without preventing default behavior. Store subscribed channels and manually blocked channels separately, compile both into set-backed indexes, and let the existing DOM/JSON filtering use the enabled source settings. The popup reads and writes only feature settings plus existing sync state.

**Tech Stack:** Firefox WebExtensions Manifest V3, vanilla JavaScript, HTML/CSS, `browser.storage.local`, YouTube DOM and page JSON interception.

## Global Constraints

- Never call `preventDefault()` or `stopPropagation()` for YouTube's “Not interested” menu item.
- Preserve existing subscription synchronization and fallback behavior.
- Store `blockedChannels` separately from subscribed `channels`.
- Feature settings default to enabled and disabling a setting must not delete stored channel data.
- Popup copy remains English and contains no feature-list panel or long subscription hint.
- Validate with `node --check`, `web-ext lint`, and a clean archive containing no `.git` or previous build artifacts.

---

### Task 1: Add separate blocked-channel state and feature settings

**Files:**
- Modify: `FreshFeed/content.js:1-100, 170-210, 300-340, 850-950`
- Modify: `FreshFeed/popup.js:1-100`
- Modify: `FreshFeed/manifest.json:1-80`

**Interfaces:**
- Consumes: existing `channels`, `enabled`, `updateSets()`, `markCard()`, and popup storage rendering.
- Produces: `blockedChannels`, `hideSubscribedChannels`, and `hideShorts` storage keys; separate blocked/subscribed indexes used by filtering. The blocked index is always enforced, and subscription changes are always synchronized.

- [x] **Step 1: Define defaults and normalized blocked state**

Add a `DEFAULT_SETTINGS` object and normalize `blockedChannels` through the same shape as `channels`:

```js
const DEFAULT_SETTINGS = {
  hideSubscribedChannels: true,
  hideShorts: true,
};
```

Keep `enabled` readable for migration, but derive the new settings from it when keys are absent.

- [x] **Step 2: Build separate indexes**

Maintain `blockedIds`, `blockedHandles`, `blockedCustomUrls`, and `blockedNames` beside the existing subscribed sets. Update `isSubscribed()` into `isHiddenChannel(channel, source)` and apply the relevant setting before checking each source.

- [x] **Step 3: Gate surfaces without deleting data**

Use `hideShorts` to skip `ytd-reel-item-renderer` handling. Each remaining content switch controls only its own filter; there is no master switch for the recommendation feed. Do not clear hidden cards when a setting is disabled without first removing only the corresponding data attribute.

- [x] **Step 4: Add migration reads**

Read all new keys in `init()` and popup refresh. When a key is missing, treat it as `saved.enabled !== false` for the main subscription behavior and `true` for the other new features.

- [x] **Step 5: Run syntax checks**

Run:

```powershell
node --check content.js
node --check popup.js
node --check page-filter.js
```

Expected: all commands exit 0.

- [x] **Step 6: Commit**

```powershell
git add content.js popup.js manifest.json
git commit -m "feat: add independent filtering settings and blocked channel state"
```

### Task 2: Capture native YouTube “Not interested” actions

**Files:**
- Modify: `FreshFeed/content.js:100-180, 230-280, 930-980`
- Modify: `FreshFeed/page-filter.js:1-130`

**Interfaces:**
- Consumes: card extraction, `mergeChannel()`, blocked-channel indexes, and native YouTube menu DOM.
- Produces: `observeNotInterestedAction()` and `addBlockedChannel(channel)`; YouTube continues to receive the original click.

- [x] **Step 1: Add stable menu-label detection**

Detect menu items from `ytd-menu-service-item-renderer`, `tp-yt-paper-item`, and accessible menu roles. Normalize `textContent`, `aria-label`, and `title`; match English “Not interested” and the Russian equivalent without matching unrelated feedback items.

- [x] **Step 2: Track card context before menu action**

On capture-phase pointer/click events, locate the nearest video card and cache its extracted channel identity in a `WeakMap` keyed by the menu button/menu host. Do not cancel the event:

```js
document.addEventListener("click", observeNotInterestedAction, true);
```

- [x] **Step 3: Add the channel after YouTube handles the click**

When the menu item is clicked, schedule a microtask plus a short timeout. Read the cached card first, then the still-present menu/card DOM. Merge the channel into `blockedChannels` with deduplication and persist it:

```js
async function addBlockedChannel(channel) {
  const result = mergeChannelCollection(state.blockedChannels, channel, false);
  if (!result.changed) return;
  state.blockedChannels = result.channels;
  updateSets();
  await browser.storage.local.set({ blockedChannels: state.blockedChannels });
}
```

- [x] **Step 4: Reapply only after storage succeeds**

After successful persistence, mark the current card hidden and schedule a home scan. On storage failure, show a concise popup-visible error in `lastBlockResult`; never report success-shaped state.

- [x] **Step 5: Add a page-filter index for blocked channels**

Publish both subscribed and blocked indexes to `page-filter.js`. Apply blocked
matching unconditionally after a channel is added through YouTube's
channel-level “Not interested” action.

- [x] **Step 6: Run syntax checks**

Run the three `node --check` commands from Task 1 and verify no event handler calls `preventDefault()` or `stopPropagation()`.

- [x] **Step 7: Commit**

```powershell
git add content.js page-filter.js
git commit -m "feat: add native Not interested channels to blacklist"
```

### Task 3: Redesign popup interaction

**Files:**
- Modify: `FreshFeed/popup.html:1-80`
- Modify: `FreshFeed/popup.js:1-110`
- Modify: `FreshFeed/popup.css:1-180`

**Interfaces:**
- Consumes: feature keys and sync state from Task 1.
- Produces: compact popup with independent switches and no feature-list or hint clutter.

- [x] **Step 1: Replace the global Enabled row**

Render the labeled switch rows with stable IDs:

```html
<input id="hide-subscribed" type="checkbox">
<input id="hide-shorts" type="checkbox">
```

- [x] **Step 2: Remove clutter**

Delete the `Features` section and the long subscription hint. Keep one compact status line for channel counts, one for last sync, the result area, and the two action buttons.

- [x] **Step 3: Bind settings**

Map each remaining checkbox to its storage key, write on `change`, and refresh
the page state after each write. Clearing the list resets only `channels`,
`syncedAt`, and `initialSyncDone`; it must not remove `blockedChannels` or
settings.

- [x] **Step 4: Show useful counts**

Display `Subscribed: N · Blacklisted: M`, using unique UC IDs first and falling back to the maximum normalized identity collection length.

- [x] **Step 5: Polish compact layout**

Keep the popup width at 280px, group switches under a “Filtering” label, and use the existing accessible label structure. Use no explanatory paragraph below the buttons.

- [x] **Step 6: Run syntax and lint checks**

Run `node --check popup.js` and `npx --yes web-ext lint --source-dir . --ignore-files 'dist/**' 'icons/icon.svg'`.

- [x] **Step 7: Commit**

```powershell
git add popup.html popup.js popup.css
git commit -m "feat: replace FreshFeed global switch with feature toggles"
```

### Task 4: Verify, document, and package the release

**Files:**
- Modify: `FreshFeed/README.md`
- Modify: `FreshFeed/manifest.json`
- Create: `FreshFeed/dist/FreshFeed-1.2.0.zip`

**Interfaces:**
- Consumes: completed runtime and popup behavior from Tasks 1-3.
- Produces: documented release and clean install archive.

- [x] **Step 1: Update README**

Document the native-click-preserving “Not interested” behavior, separate blacklist, independent settings, and the fact that disabling a switch preserves stored data.

- [x] **Step 2: Bump version**

Set `manifest.json` to `1.2.0`.

- [x] **Step 3: Run full validation**

Run:

```powershell
node --check content.js
node --check popup.js
node --check page-filter.js
npx --yes web-ext lint --source-dir . --ignore-files 'dist/**' 'icons/icon.svg'
git diff --check
```

Expected: zero syntax/lint errors; only the pre-existing Firefox Android compatibility warning may remain.

- [x] **Step 4: Build a clean archive**

Copy all project files except `.git`, `dist`, and dependency directories into a temporary staging directory, compress it to `dist/FreshFeed-1.2.0.zip`, and verify the archive contains `manifest.json`, `content.js`, `page-filter.js`, popup files, icons, README, and LICENSE.

- [x] **Step 5: Commit**

```powershell
git add README.md manifest.json
git commit -m "release: package FreshFeed 1.2.0"
```
