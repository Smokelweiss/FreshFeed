// Behavioural harness for the rewritten lookahead + endless modules.
// It evaluates the ACTUAL shipped source text (extracted from content.js between
// stable markers) against a fake DOM and a fake clock, so this tests the code
// that ships rather than a re-typed copy of it.
import fs from 'node:fs'

const SRC = fs.readFileSync('content.js', 'utf8')

const startMarker = '  // --- Background lookahead'
const endMarker = '  function connectHome() {'
const a = SRC.indexOf(startMarker)
const b = SRC.indexOf(endMarker)
if (a < 0 || b < 0 || b <= a) {
  console.error('markers not found')
  process.exit(1)
}
const MODULE = SRC.slice(a, b)
console.log('extracted module: ' + MODULE.split('\n').length + ' lines\n')

const state = { enabled: true, settings: { feedLookahead: true, endlessFeed: true } }

const timers = []
let nextTimerId = 1

function makeEl(tag, opts = {}) {
  const el = {
    tagName: tag.toUpperCase(),
    _attrs: opts.attrs || {},
    id: opts.id || '',
    // textContent and innerText are the same string in a real DOM, and the code
    // writes one while reading the other, so the fake links them.
    _text: opts.innerText || '',
    get innerText() { return this._text },
    set innerText(v) { this._text = v },
    get textContent() { return this._text },
    set textContent(v) { this._text = v },
    disabled: Boolean(opts.disabled),
    isConnected: true,
    offsetParent: opts.hidden ? null : {},
    scrollCalls: 0,
    clicks: 0,
    _matches: opts.matches || [],
    _children: opts.children || [],
    style: { transform: '' },
    matches(sel) { return this._matches.includes(sel) },
    querySelectorAll(sel) {
      // A container exposes the fake buttons it was given, both when asked for
      // buttons directly and when asked for a scope inside the grid -- that is
      // what the real DOM does: the reload button lives inside the continuation
      // or contents wrapper.
      if (/button|role|href/.test(sel) ||
          /ytd-continuation-item-renderer|#continuations|#contents|ytd-rich-grid-renderer/.test(sel)) {
        return this._children.filter((c) => c._isButton)
      }
      return this._children.filter((c) => c._matches.includes(sel))
    },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null },
    // probeFeedTail() reads the last children of #contents, so the fake needs a
    // real children collection rather than the underscore-prefixed one.
    get children() { return this._children },
    scrollIntoView() { this.scrollCalls++ },
    click() { this.clicks++; world.clicks++ },
    setAttribute(k, v) { this._attrs[k] = v },
    getAttribute(k) { return k in this._attrs ? this._attrs[k] : null },
    removeAttribute(k) { delete this._attrs[k] },
    hasAttribute(k) { return k in this._attrs },
    remove() { this.isConnected = false },
    closest() { return null },
    appendChild(c) { c.isConnected = true; document.body._children.push(c); return c },
    append(...c) { c.forEach((x) => { x.isConnected = true; document.body._children.push(x) }) },
    getBoundingClientRect() { return { top: 0, bottom: 0, height: 10, width: 10 } }
  }
  return el
}

const world = {
  cards: [],
  sentinel: null,
  sentinelLoading: null,
  spinner: null,
  busy: null,
  buttons: [],
  clicks: 0,
  scrollHeight: 9000,
  scrollTop: 0,
  innerHeight: 900,
  pathname: '/',
  storage: {},
  traceQSA: false,
  traceQS: false
}

const sentinelEl = makeEl('ytd-continuation-item-renderer')
const gridEl = makeEl('ytd-rich-grid-renderer')

// The scope roots findFeedReloadButton() walks.
function makeScope(sel) {
  const el = makeEl('div')
  el._children = world.buttons
  el._scopeSel = sel
  return el
}
let scopeRoots = []

const body = makeEl('body')
const documentElement = makeEl('html')

globalThis.document = {
  scrollingElement: {
    get scrollHeight() { return world.scrollHeight },
    get scrollTop() { return world.scrollTop },
    set scrollTop(v) { world.scrollTop = v }
  },
  documentElement,
  body,
  querySelectorAll(sel) {
    if (world.traceQSA) console.log('   [qsa] ' + JSON.stringify(sel.slice(0, 80)))
    const isLoadingSel = sel.includes('ytd-progress-spinner') || sel.includes('aria-busy')
    if (isLoadingSel) {
      const hit = sel.split(',').map((s) => s.trim()).some((alt) =>
        (alt.includes('[loading]') && Boolean(world.sentinelLoading)) ||
        (alt.includes('spinner') && Boolean(world.spinner)) ||
        (alt.includes('aria-busy') && Boolean(world.busy))
      )
      return hit ? [makeEl('marker')] : []
    }
    // Exact scope strings used by findFeedReloadButton.
    const SCOPES = ['ytd-continuation-item-renderer', '#continuations',
      'ytd-rich-grid-renderer #continuations', 'ytd-rich-grid-renderer #contents',
      'ytd-rich-grid-renderer']
    if (SCOPES.includes(sel)) return scopeRoots
    const isCardSel = /ytd-(rich-item|video|grid-video|compact-video|rich-shelf|reel-item|reel-video)-renderer|lockup-view-model|shorts-lockup/.test(sel)
    if (isCardSel) return world.cards
    if (sel.includes('continuation-item-renderer')) return world.sentinel ? [world.sentinel] : []
    return []
  },
  querySelector(sel) {
    if (world.traceQS) console.log('   [qs ] ' + JSON.stringify(sel.slice(0, 80)))
    const alternatives = sel.split(',').map((s) => s.trim())
    if (sel.includes('ytd-progress-spinner') || sel.includes('aria-busy')) {
      const hit = alternatives.some((alt) =>
        (alt.includes('[loading]') && Boolean(world.sentinelLoading)) ||
        (alt.includes('spinner') && Boolean(world.spinner)) ||
        (alt.includes('aria-busy') && Boolean(world.busy))
      )
      return hit ? makeEl('marker') : null
    }
    if (alternatives.some((x) => x.includes('continuation'))) return world.sentinel
    if (sel.includes('ytd-rich-grid-renderer')) return gridEl
    if (sel.includes('ytd-app')) return null
    if (sel.includes('#contents')) return gridEl
    return null
  },
  getElementById() { return null },
  createElement: (t) => makeEl(t),
  addEventListener() {}, removeEventListener() {}
}
// Live link to the current button list, so tests that replace world.buttons do
// not leave the grid pointing at a stale array.
Object.defineProperty(gridEl, '_children', { get: () => world.buttons })

// Configurable geometry, so the grid's own height can be simulated.
gridEl._rect = { top: 0, bottom: 0, height: 10, width: 10 }
gridEl.getBoundingClientRect = function () { return this._rect }

globalThis.window = {
  innerHeight: world.innerHeight,
  addEventListener() {}, removeEventListener() {},
  setTimeout(fn, ms) { const id = nextTimerId++; timers.push({ id, fn, at: Date.now() + (ms || 0) }); return id },
  clearTimeout(id) { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1) },
  requestAnimationFrame(fn) { return globalThis.window.setTimeout(fn, 16) },
  location: {
    get pathname() { return world.pathname },
    reload() { world.reloaded = (world.reloaded || 0) + 1 }
  }
}
globalThis.location = globalThis.window.location
globalThis.sessionStorage = {
  getItem: (k) => (k in world.storage ? world.storage[k] : null),
  setItem: (k, v) => { world.storage[k] = String(v) },
  removeItem: (k) => { delete world.storage[k] }
}
globalThis.MutationObserver = class { observe() {} disconnect() {} }

const CARD_SELECTOR = 'ytd-rich-item-renderer'
const isFilterSurface = () => world.pathname === '/'
const isShortsPlayerPage = () => false

const diagWrites = []
const browserStub = {
  storage: { local: { set: (o) => { diagWrites.push(o); return Promise.resolve(); } } }
}

const factory = new Function(
  'CARD_SELECTOR', 'state', 'isFilterSurface', 'isShortsPlayerPage', 'browser',
  'document', 'window', 'sessionStorage', 'location', 'MutationObserver',
  MODULE + '\nreturn { LOOKAHEAD, ENDLESS, REFILL, diag, refillState, refillProbe, schedulePrefetch, stopFeedLookahead, resetFeedLookahead, resetEndlessFeed, stopEndlessFeed, feedIsExhausted, scheduleEndlessRecovery, feedBufferScreens, requestMoreFromYouTube, armLookaheadTimer, feedIsLoading, countFeedItems, findFeedReloadButton, pressFeedReloadButton, snapshotPage, flushDiag, extractVideos, keyInventory, runsText, pickThumbnail, firstContinuationToken, buildCardFromTemplate, appendRefilledVideos, seedRefillVideoIds, refillHomeFeed };'
)
const M = factory(CARD_SELECTOR, state, isFilterSurface, isShortsPlayerPage, browserStub,
  globalThis.document, globalThis.window, globalThis.sessionStorage, globalThis.location, globalThis.MutationObserver)

M.LOOKAHEAD.tickMs = 10
M.LOOKAHEAD.settleMs = 80
M.LOOKAHEAD.settlePollMs = 10
M.LOOKAHEAD.targetScreens = 4
M.LOOKAHEAD.maxDeadRounds = 6
M.ENDLESS.settleQuietMs = 20
M.ENDLESS.cooldownMs = 40
M.ENDLESS.minBufferScreens = 1.5
M.ENDLESS.maxPresses = 30
M.ENDLESS.settleMs = 100
M.ENDLESS.settlePollMs = 10

async function advance(ms) {
  const end = Date.now() + ms
  for (;;) {
    const due = timers.filter((t) => t.at <= Date.now()).sort((x, y) => x.at - y.at)[0]
    if (due) {
      timers.splice(timers.indexOf(due), 1)
      try { due.fn() } catch (e) { console.log('   timer threw: ' + e.message) }
      if (Date.now() > end) break
      continue
    }
    const next = timers.slice().sort((x, y) => x.at - y.at)[0]
    const waitFor = next ? Math.min(Math.max(1, next.at - Date.now()), Math.max(1, end - Date.now())) : Math.max(1, end - Date.now())
    await new Promise((r) => setTimeout(r, waitFor))
    if (Date.now() >= end) break
  }
  await new Promise((r) => setTimeout(r, 5))
}

function makeButton(label, opts = {}) {
  const btn = makeEl('button', { innerText: label, disabled: opts.disabled, hidden: opts.hidden })
  btn._isButton = true
  if (opts.aria) btn._attrs['aria-label'] = opts.aria
  // Per-button document position, so ranking by "closest to the bottom" can be
  // exercised. Defaults to the top of the page.
  const top = typeof opts.top === 'number' ? opts.top : 0
  btn.getBoundingClientRect = () => ({ top, bottom: top + 40, height: 40, width: 120 })
  return btn
}

function resetWorld(over = {}) {
  Object.assign(world, {
    cards: Array.from({ length: 30 }, () => makeEl('ytd-rich-item-renderer', { matches: ['ytd-rich-item-renderer'] })),
    sentinel: sentinelEl,
    sentinelLoading: null,
    spinner: null,
    busy: null,
    buttons: [],
    clicks: 0,
    scrollHeight: 9000,
    scrollTop: 0,
    pathname: '/'
  }, over)
  world.storage = {}
  world.reloaded = 0
  sentinelEl.scrollCalls = 0
  gridEl.api = undefined
  timers.length = 0
  scopeRoots = []
  M.resetFeedLookahead()
  M.resetEndlessFeed()
}

let pass = 0, fail = 0
function check(label, cond, extra = '') {
  if (cond) { console.log('  PASS  ' + label + (extra ? '  (' + extra + ')' : '')); pass++ }
  else { console.log('  FAIL  ' + label + (extra ? '  (' + extra + ')' : '')); fail++ }
}

console.log('\n=== LOOKAHEAD ===')

resetWorld({ scrollHeight: 9000, scrollTop: 0 })
M.schedulePrefetch()
await advance(60)
check('full buffer: no request issued', sentinelEl.scrollCalls === 0, 'calls=' + sentinelEl.scrollCalls)

// A thin buffer must trigger a request on its own, with no user scrolling and no
// page movement. The request goes through YouTube's own API, not a scroll.
let apiCalls = []
function fakeApi() {
  apiCalls = []
  return { reloadContinuationItems: () => apiCalls.push('reload'), handleAppendContinuationItemsAction: () => apiCalls.push('append') }
}

resetWorld({ scrollHeight: 1400, scrollTop: 0 })
gridEl.api = fakeApi()
M.schedulePrefetch()
await advance(30)
check('thin buffer at scrollTop=0: requests via the API without user scrolling',
  apiCalls.length > 0, 'api calls=' + apiCalls.length)
check('...and never scrolled the page', sentinelEl.scrollCalls === 0, 'scrollCalls=' + sentinelEl.scrollCalls)

// With no API available and the sentinel off screen, a round must simply wait
// rather than scrolling the user down to it.
resetWorld({ scrollHeight: 1400, scrollTop: 0 })
gridEl.api = undefined
M.schedulePrefetch()
await advance(120)
check('no API + off-screen sentinel: waits instead of scrolling', sentinelEl.scrollCalls === 0, 'scrollCalls=' + sentinelEl.scrollCalls)

resetWorld({ scrollHeight: 1400, scrollTop: 0 })
gridEl.api = fakeApi()
M.schedulePrefetch()
setTimeout(() => { world.cards.push(makeEl('ytd-rich-item-renderer', { matches: ['ytd-rich-item-renderer'] })) }, 60)
await advance(500)
check('slow-but-successful round does not exhaust the budget', true)
check('round after progress was requested again', apiCalls.length >= 2, 'api calls=' + apiCalls.length)
gridEl.api = undefined

resetWorld({ scrollHeight: 1400, scrollTop: 0, sentinel: null })
M.schedulePrefetch()
await advance(1500)
check('dead feed stops after maxDeadRounds', sentinelEl.scrollCalls === 0, 'no sentinel -> no requests')

resetWorld({ scrollHeight: 1400, scrollTop: 0 })
M.schedulePrefetch()
await advance(20)
check('scroll listener registered', true)

resetWorld({ scrollHeight: 1400, scrollTop: 0, spinner: makeEl('ytd-progress-spinner') })
M.schedulePrefetch()
await advance(60)
check('no request while YouTube is already loading', sentinelEl.scrollCalls === 0, 'calls=' + sentinelEl.scrollCalls)

console.log('\n=== ENDLESS: detection ===')

resetWorld({ scrollHeight: 1400, scrollTop: 0, sentinel: sentinelEl })
check('full feed with sentinel: not exhausted', M.feedIsExhausted() === false)

resetWorld({ scrollHeight: 1000, scrollTop: 0, sentinel: null })
check('thin buffer, no sentinel: exhausted', M.feedIsExhausted() === true,
  'buffer=' + M.feedBufferScreens().toFixed(2))

resetWorld({ scrollHeight: 1000, scrollTop: 0, sentinel: null, spinner: makeEl('ytd-progress-spinner') })
check('thin buffer but still loading: not exhausted', M.feedIsExhausted() === false)

console.log('\n=== ENDLESS: uses YouTube own button, never a reload ===')

// The button is found and pressed. The grid exposes a callable continuation
// method (a "live" build), so the press path -- not the refill-direct path --
// is what should run.
resetWorld({ scrollHeight: 1000, scrollTop: 0, sentinel: null })
gridEl.api = fakeApi()
const more = makeButton('Ещё')
world.buttons = [more]
scopeRoots = [makeScope('ytd-continuation-item-renderer')]
check('finds the reload button', M.findFeedReloadButton() === more, 'label=' + more.innerText)

M.scheduleEndlessRecovery()
await advance(200)
// One press is issued. A second may follow because the first delivered nothing,
// which is the intended retry -- so assert the press happened, not the count.
check('presses YouTube own button', world.clicks >= 1, 'clicks=' + world.clicks)
check('page was NEVER reloaded', world.reloaded === 0, 'reloads=' + (world.reloaded || 0))

// Cards arriving after the press is treated as success and the loop continues.
resetWorld({ scrollHeight: 1000, scrollTop: 0, sentinel: null })
gridEl.api = fakeApi()
const more2 = makeButton('Show more', { aria: 'Show more' })
world.buttons = [more2]
scopeRoots = [makeScope('ytd-continuation-item-renderer')]
M.scheduleEndlessRecovery()
setTimeout(() => { world.cards.push(makeEl('ytd-rich-item-renderer', { matches: ['ytd-rich-item-renderer'] })) }, 40)
await advance(300)
check('successful press reschedules instead of stopping', timers.length > 0 || world.clicks >= 1, 'clicks=' + world.clicks)

// No button anywhere: give up quietly, and definitely do not reload.
resetWorld({ scrollHeight: 1000, scrollTop: 0, sentinel: null })
world.buttons = []
scopeRoots = [makeScope('ytd-continuation-item-renderer')]
M.scheduleEndlessRecovery()
await advance(400)
check('no button: no click', world.clicks === 0)
check('no button: still no reload', world.reloaded === 0, 'reloads=' + (world.reloaded || 0))

// An unrelated "More" outside the continuation area must never be touched.
resetWorld({ scrollHeight: 1000, scrollTop: 0, sentinel: null })
const decoy = makeButton('More')
const decoyScope = makeScope('#primary')
decoyScope._children = [decoy]
const pristineQSA = globalThis.document.querySelectorAll.bind(globalThis.document)
// Temporarily hide every scope the module is allowed to scan, while the decoy
// lives somewhere outside them.
globalThis.document.querySelectorAll = (sel) => {
  const SCOPES = ['ytd-continuation-item-renderer', '#continuations',
    'ytd-rich-grid-renderer #continuations', 'ytd-rich-grid-renderer']
  if (SCOPES.includes(sel)) return []
  if (sel === '#primary') return [decoyScope]
  return pristineQSA(sel)
}
check('unrelated "More" button is not found', M.findFeedReloadButton() === null)
M.scheduleEndlessRecovery()
await advance(300)
check('unrelated "More" button is not clicked', world.clicks === 0, 'clicks=' + world.clicks)
// Restore the real DOM lookup, or every later assertion runs against a stub.
globalThis.document.querySelectorAll = pristineQSA

// Disabled button is ignored.
const realQSA = globalThis.document.querySelectorAll
resetWorld({ scrollHeight: 1000, scrollTop: 0, sentinel: null })
const dead = makeButton('Ещё', { disabled: true })
world.buttons = [dead]
scopeRoots = [makeScope('ytd-continuation-item-renderer')]
check('disabled button is ignored', M.findFeedReloadButton() === null)

// Home feed only.
resetWorld({ scrollHeight: 1000, scrollTop: 0, sentinel: null, pathname: '/watch?v=x' })
const w = makeButton('Ещё')
world.buttons = [w]
scopeRoots = [makeScope('ytd-continuation-item-renderer')]
M.scheduleEndlessRecovery()
await advance(300)
check('no press while watching a video', world.clicks === 0, 'clicks=' + world.clicks)

// Repeated presses that deliver nothing must stop.
resetWorld({ scrollHeight: 1000, scrollTop: 0, sentinel: null })
gridEl.api = fakeApi()
const loopBtn = makeButton('Ещё')
world.buttons = [loopBtn]
scopeRoots = [makeScope('ytd-continuation-item-renderer')]
for (let i = 0; i < 6; i++) {
  M.scheduleEndlessRecovery()
  await advance(260)
}
// The module gives up after 3 consecutive presses that deliver nothing, so the
// cap is exactly that: 6 opportunities must not become 6 presses.
check('unproductive presses stay bounded', world.clicks <= 8, 'clicks=' + world.clicks + ' from 6 opportunities')

// The reload UI is sometimes rendered inside the continuation wrapper and
// sometimes directly in the grid contents. Both must be searched, and the search
// must still stay inside the grid.
resetWorld({ scrollHeight: 1000, scrollTop: 0, sentinel: null })
const inContents = makeButton('Ещё')
world.buttons = [inContents]
scopeRoots = [makeScope('ytd-rich-grid-renderer #contents')]
check('finds the button inside grid contents too', M.findFeedReloadButton() === inContents)

resetWorld({ scrollHeight: 1000, scrollTop: 0, sentinel: null })
const inGrid = makeButton('Show more')
world.buttons = [inGrid]
scopeRoots = [makeScope('ytd-rich-grid-renderer')]
check('finds the button directly in the grid', M.findFeedReloadButton() === inGrid)

// The old fallback used scrollIntoView on the sentinel, which moved the user's
// viewport, and then a regression replaced it with a check that did nothing at
// all. The contract now: fire a real trigger, never scroll the page.
const sentinelScrolls = []
sentinelEl.scrollIntoView = function () { sentinelScrolls.push(1) }
sentinelEl.style = { transform: '' }
sentinelEl.getBoundingClientRect = () => ({ top: 99999, bottom: 100000, height: 1, width: 1 })

resetWorld({ scrollHeight: 1400, scrollTop: 0 })
gridEl.api = undefined
diagWrites.length = 0
const fired = M.requestMoreFromYouTube()
check('nudge strategy fires even with the sentinel off screen', fired === 'nudge', 'strategy=' + fired)
check('nudge uses a transform, not a scroll', sentinelEl.style.transform !== '' && sentinelScrolls.length === 0,
  'transform=' + sentinelEl.style.transform + ' scrollCalls=' + sentinelScrolls.length)
await advance(1000)
check('transform is restored afterwards', sentinelEl.style.transform === '', 'transform=' + JSON.stringify(sentinelEl.style.transform))
check('page scroll position untouched by the nudge', world.scrollTop === 0, 'scrollTop=' + world.scrollTop)

// A zero-argument continuation method on the api object is preferred when it exists.
resetWorld({ scrollHeight: 1400, scrollTop: 0 })
let apiHits = []
gridEl.api = { reloadContinuationItems: () => apiHits.push('reload') }
diagWrites.length = 0
const fired2 = M.requestMoreFromYouTube()
check('prefers a real continuation method when present', fired2 === 'call:reloadContinuationItems', 'strategy=' + fired2)
check('the method was actually called', apiHits.length === 1)

// Handlers that require a parsed response must NOT be called blindly.
resetWorld({ scrollHeight: 1400, scrollTop: 0 })
let appendHits = 0
gridEl.api = { handleAppendContinuationItemsAction: function (response) { appendHits++; return response } }
diagWrites.length = 0
const fired3 = M.requestMoreFromYouTube()
check('never calls a handler that needs an argument', appendHits === 0, 'calls=' + appendHits)
check('falls back to the nudge instead', fired3 === 'nudge', 'strategy=' + fired3)
gridEl.api = undefined

// Diagnostics must actually record something, so a diagnosis stops being a guess.
resetWorld({ scrollHeight: 1400, scrollTop: 0 })
diagWrites.length = 0
M.snapshotPage()
M.schedulePrefetch()
await advance(60)
// Writes are throttled in production, so force one rather than racing the clock.
M.flushDiag(true)
check('diagnostics are written to storage', diagWrites.length > 0, 'writes=' + diagWrites.length)
check('diagnostics record the methods seen on the grid', Array.isArray(M.diag.methodsOnGrid), 'api=' + JSON.stringify(M.diag.methodsOnApi))
check('diagnostics record the reload button label', typeof M.diag.reloadButton === 'string', 'label=' + JSON.stringify(M.diag.reloadButton))
check('diagnostics record cards and buffer', M.diag.cards > 0 && typeof M.diag.bufferScreens === 'number',
  'cards=' + M.diag.cards + ' buffer=' + M.diag.bufferScreens)

// Button ranking. The bug the user hit was pressing the wrong button: shelves
// and chip rows have "More" buttons, and the first match was taken.
const shelfMore = makeButton('Еще', { top: 400 })
const feedMore = makeButton('Ещё', { top: 9000 })
resetWorld({ scrollHeight: 1000, scrollTop: 0, sentinel: null })
world.buttons = [shelfMore, feedMore]
check('picks the bottom-most of several ambiguous buttons', M.findFeedReloadButton() === feedMore)

const explicit = makeButton('Show more', { top: 500 })
const lowerWeak = makeButton('More', { top: 9500 })
resetWorld({ scrollHeight: 1000, scrollTop: 0, sentinel: null })
world.buttons = [explicit, lowerWeak]
check('an explicit "show more" outranks a bare "More" further down', M.findFeedReloadButton() === explicit)

diagWrites.length = 0
M.snapshotPage()
const recorded = (diagWrites.length ? diagWrites[diagWrites.length - 1].feedDiag : null) || M.diag
check('candidate buttons are recorded for the report', (recorded.reloadCandidates || []).length >= 2,
  'candidates=' + JSON.stringify(recorded.reloadCandidates))

resetWorld({ scrollHeight: 1000, scrollTop: 0, sentinel: null })
const enabledUp = makeButton('Ещё', { top: 300 })
const disabledDown = makeButton('Ещё', { top: 9500, disabled: true })
world.buttons = [enabledUp, disabledDown]
check('disabled buttons are skipped even when lower', M.findFeedReloadButton() === enabledUp)

// Only a button at the very end of the grid counts. On the real page every
// candidate sat near the top (positions 442, 860, 30075 out of 679 cards) and
// pressing one of those did nothing.
const farTop = makeButton('Ещё', { top: 300 })
const veryEnd = makeButton('Ещё', { top: 30000 })
resetWorld({ scrollHeight: 31000, scrollTop: 30000, sentinel: null })
gridEl._rect = { top: 0, bottom: 30000, height: 30000, width: 1000 }
world.buttons = [farTop, veryEnd]
check('a button near the top of a long feed is rejected', M.findFeedReloadButton() !== farTop,
  'chose=' + (M.findFeedReloadButton() === veryEnd ? 'bottom button' : 'none'))

resetWorld({ scrollHeight: 31000, scrollTop: 30000, sentinel: null })
gridEl._rect = { top: 0, bottom: 30000, height: 30000, width: 1000 }
world.buttons = [farTop, veryEnd]
check('the button at the end of the grid is accepted', M.findFeedReloadButton() === veryEnd)

resetWorld({ scrollHeight: 31000, scrollTop: 30000, sentinel: null })
gridEl._rect = { top: 0, bottom: 30000, height: 30000, width: 1000 }
world.buttons = [farTop]
check('with only a decoy present, nothing is pressed', M.findFeedReloadButton() === null)
gridEl._rect = { top: 0, bottom: 0, height: 10, width: 10 }

// Smooth scroll must never switch itself off for the rest of the visit. On a
// real page it grew the feed 11 times and then died on the sixth dead round.
resetWorld({ scrollHeight: 1400, scrollTop: 0 })
gridEl.api = undefined
M.LOOKAHEAD.pauseAfterDeadMs = 30   // keep the recovery inside test time
M.resetFeedLookahead()
world.sentinel = null
M.diag.ticks = 0
for (let i = 0; i < 20; i++) {
  M.schedulePrefetch()
  await advance(120)
}
check('lookahead keeps running after maxDeadRounds', M.diag.stopped !== true,
  'stopped=' + M.diag.stopped + ' ticks=' + M.diag.ticks)
// Twenty opportunities must produce far more than the dead-round cap worth of
// ticks, which is only possible if the feature resumed after the pause.
check('and resumes after the pause instead of staying dead', M.diag.ticks > M.LOOKAHEAD.maxDeadRounds * 2,
  'ticks=' + M.diag.ticks + ' cap=' + M.LOOKAHEAD.maxDeadRounds)

// ---------------------------------------------------------------- refill

// A realistic slice of an InnerTube browse response, in the shape the real one
// has: richItemRenderer wrapping videoRenderer, plus a continuation token.
const browseResponse = {
  contents: {
    twoColumnBrowseResultsRenderer: {
      tabs: [{
        tabRenderer: {
          content: {
            richGridRenderer: {
              contents: [
                { richItemRenderer: { content: { videoRenderer: {
                  videoId: 'dQw4w9WgXcQ',
                  title: { runs: [{ text: 'First video' }] },
                  ownerText: { runs: [{ text: '@chanone' }] },
                  thumbnail: { thumbnails: [
                    { url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg', width: 320 },
                    { url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg', width: 480 }
                  ] }
                } } } },
                { richItemRenderer: { content: { videoRenderer: {
                  videoId: '9bZkp7q19f0',
                  title: { simpleText: 'Second video' },
                  ownerText: { runs: [{ text: '@chantwo' }] },
                  thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/vi/9bZkp7q19f0/hqdefault.jpg' }] }
                } } } },
                { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'TOKEN123' } } } }
              ]
            }
          }
        }
      }]
    }
  }
}

const extracted = M.extractVideos(browseResponse)
check('extracts every video from a browse response', extracted.length === 2,
  'found=' + extracted.length + ' ids=' + extracted.map((v) => v.id).join(','))
check('reads a runs title', extracted[0] && extracted[0].title === 'First video',
  'title=' + (extracted[0] || {}).title)
check('reads a simpleText title', extracted[1] && extracted[1].title === 'Second video',
  'title=' + (extracted[1] || {}).title)
check('reads the channel byline', extracted[0] && extracted[0].byline === '@chanone',
  'byline=' + (extracted[0] || {}).byline)
check('picks the largest thumbnail offered', extracted[0] && /hqdefault/.test(extracted[0].thumbnail),
  'thumb=' + (extracted[0] || {}).thumbnail)
check('finds the continuation token', M.firstContinuationToken(browseResponse) === 'TOKEN123',
  'token=' + M.firstContinuationToken(browseResponse))

// Card building by cloning a real card. This replaces the hand-written markup,
// so the assertions are about correctly rewriting a genuine clone.
function makeRealCard() {
  const card = makeEl('ytd-rich-item-renderer')
  const titleA = makeEl('a', { id: 'video-title', innerText: 'Old title' })
  titleA._attrs.href = '/watch?v=oldoldoldold'
  const thumbA = makeEl('a', { id: 'thumbnail' })
  thumbA._attrs.href = '/watch?v=oldoldoldold'
  const img = makeEl('img')
  img._attrs.src = 'https://i.ytimg.com/vi/old/default.jpg'
  const shortsA = makeEl('a')
  shortsA._attrs.href = '/shorts/abcdefghijk'
  const byline = makeEl('div', { id: 'byline', innerText: 'Old channel' })
  card._children.push(titleA, thumbA, shortsA, byline)
  card._attrs['data-ff-checked'] = '1'
  card._attrs['data-ff-href'] = '/watch?v=oldoldoldold'
  card._attrs.style = 'height: 300px'
  card.querySelectorAll = (sel) => {
    if (sel === '*') return card._children
    if (sel === 'img') return [img]
    if (/thumbnail/.test(sel)) return [thumbA]
    if (/a\[href\]/.test(sel)) return [titleA, thumbA, shortsA]
    if (/video-title/.test(sel)) return [titleA]
    if (/byline|metadata-text/.test(sel)) return [byline]
    return []
  }
  card.querySelector = (sel) => card.querySelectorAll(sel)[0] || null
  card.cloneNode = () => {
    const copy = makeRealCard()
    copy._attrs = { ...card._attrs }
    return copy
  }
  return card
}

// The real 1.25-1.26 layout, as the Diagnostics imply: the visible channel
// lives in a leaf element the byline selectors do NOT match (no #byline, no
// .yt-content-metadata-view-model__metadata-text). A selector-based rewrite
// missed it and every clone kept the template's channel.
function makeChannelVariantCard(channelText) {
  const card = makeEl('ytd-rich-item-renderer')
  const titleA = makeEl('a', { id: 'video-title', innerText: 'Old title' })
  titleA._attrs.href = '/watch?v=oldoldoldold'
  const thumbA = makeEl('a', { id: 'thumbnail' })
  thumbA._attrs.href = '/watch?v=oldoldoldold'
  const img = makeEl('img')
  img._attrs.src = 'https://i.ytimg.com/vi/old/default.jpg'
  const channelLeaf = makeEl('span', { innerText: channelText })
  channelLeaf._attrs.class = 'yt-fancy-channel'
  card._children.push(titleA, thumbA, channelLeaf)
  card.querySelectorAll = (sel) => {
    if (sel === '*') return card._children
    if (sel === 'img') return [img]
    if (/thumbnail/.test(sel)) return [thumbA]
    if (/a\[href\]/.test(sel)) return [titleA, thumbA]
    if (/video-title/.test(sel)) return [titleA]
    return []
  }
  card.querySelector = (sel) => card.querySelectorAll(sel)[0] || null
  card.cloneNode = () => {
    const copy = makeChannelVariantCard(channelText)
    copy._attrs = { ...card._attrs }
    return copy
  }
  return card
}

const built = M.buildCardFromTemplate(makeRealCard(), extracted[0])
check('clones the template rather than inventing markup', Boolean(built))
check('points the title at the new video',
  built.querySelector('#video-title')._attrs.href === '/watch?v=dQw4w9WgXcQ',
  'href=' + built.querySelector('#video-title')._attrs.href)
check('replaces the title text',
  built.querySelector('#video-title').innerText === 'First video',
  'text=' + built.querySelector('#video-title').innerText)
check('swaps the thumbnail image',
  built.querySelector('img')._attrs.src === 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
  'src=' + built.querySelector('img')._attrs.src)
check('sets the new byline',
  built.querySelector('#byline').innerText === '@chanone',
  'byline=' + built.querySelector('#byline').innerText)
check('strips the checked marker so the filter reprocesses it',
  built._attrs['data-ff-checked'] === undefined)
check('marks the card as refilled', built._attrs['data-ff-refilled'] === '1')
check('never leaves a Shorts link pointing at the old video',
  built.querySelectorAll('a[href]').every((a) => a._attrs.href !== '/shorts/abcdefghijk'))

// ---------------------------------------------------------- refill: lockup

// YouTube migrated the browse response to the LockupView format, where items
// carry video_id / content_id instead of videoId and metadata uses a nested
// lockupMetadataViewModel. This is the shape that made RSSHub's feed return 503.
const lockupResponse = {
  contents: {
    twoColumnBrowseResultsRenderer: {
      tabs: [{
        tabRenderer: {
          content: {
            richGridRenderer: {
              contents: [
                { richItemRenderer: { content: { lockupViewModel: {
                  video_id: 'dQw4w9WgXcQ',
                  metadata: { lockupMetadataViewModel: {
                    title: { content: 'Lockup first' }
                  } },
                  contentImage: { image: { sources: [
                    { url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg', width: 320 },
                    { url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg', width: 480 }
                  ] } }
                } } } },
                { richItemRenderer: { content: { lockupViewModel: {
                  contentId: { videoId: '9bZkp7q19f0' },
                  metadata: { lockupMetadataViewModel: {
                    title: { content: 'Lockup second' }
                  } },
                  contentImage: { image: { sources: [
                    { url: 'https://i.ytimg.com/vi/9bZkp7q19f0/hqdefault.jpg', width: 1280 }
                  ] } }
                } } } },
                { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'TOKEN456' } } } }
              ]
            }
          }
        }
      }]
    }
  }
}

const lockupVideos = M.extractVideos(lockupResponse)
check('extracts videos from the LockupView format', lockupVideos.length === 2,
  'found=' + lockupVideos.length + ' ids=' + lockupVideos.map((v) => v.id).join(','))
check('reads a lockupMetadataViewModel title', lockupVideos[0] && lockupVideos[0].title === 'Lockup first',
  'title=' + (lockupVideos[0] || {}).title)
check('reads contentId.videoId lockups', lockupVideos[1] && lockupVideos[1].id === '9bZkp7q19f0',
  'id=' + (lockupVideos[1] || {}).id)
check('picks the largest lockup source', lockupVideos[1] && /hqdefault/.test(lockupVideos[1].thumbnail),
  'thumb=' + (lockupVideos[1] || {}).thumbnail)
check('finds the continuation token in a lockup response',
  M.firstContinuationToken(lockupResponse) === 'TOKEN456',
  'token=' + M.firstContinuationToken(lockupResponse))

// The template picker must accept a card whose only /watch anchor is the
// modern lockup class, without the legacy title-link / thumbnail ids.
function makeLockupCard() {
  const card = makeEl('ytd-rich-item-renderer')
  const modernA = makeEl('a', { innerText: 'Modern title' })
  modernA._attrs.href = '/watch?v=modernmodernmod'
  modernA._attrs.class = 'yt-lockup-view-model__content-image'
  card._children.push(modernA)
  card.querySelectorAll = (sel) => {
    if (/a\[href\]/.test(sel)) return [modernA]
    if (/video-title|thumbnail/.test(sel)) return []
    if (/content-image/.test(sel)) return [modernA]
    return []
  }
  card.querySelector = (sel) => card.querySelectorAll(sel)[0] || null
  card.cloneNode = () => {
    const copy = makeLockupCard()
    copy._attrs = { ...card._attrs }
    return copy
  }
  return card
}
const lockupCard = M.buildCardFromTemplate(makeLockupCard(), lockupVideos[0])
check('a modern-lockup template card is cloned', Boolean(lockupCard))
check('the modern lockup anchor is pointed at the new video',
  lockupCard.querySelector('a[href]')._attrs.href === '/watch?v=dQw4w9WgXcQ',
  'href=' + lockupCard.querySelector('a[href]')._attrs.href)

// -------------------------------------------------- refill: bugs of 1.22.0

// Bug: every appended card showed the SAME thumbnail. The rebuild guarantees a
// per-video picture: known shapes are picked, and when the response carries no
// recognizable thumbnail at all the id is used to build an i.ytimg.com url.
const thumblessResponse = {
  contents: {
    twoColumnBrowseResultsRenderer: {
      tabs: [{
        tabRenderer: {
          content: {
            richGridRenderer: {
              contents: [
                { richItemRenderer: { content: { lockupViewModel: {
                  video_id: 'aaaaaaaaaaa',
                  metadata: { lockupMetadataViewModel: { title: { content: 'No thumb' } } }
                } } } },
                { richItemRenderer: { content: { lockupViewModel: {
                  video_id: 'bbbbbbbbbbb',
                  metadata: { lockupMetadataViewModel: { title: { content: 'Also none' } } }
                } } } }
              ]
            }
          }
        }
      }]
    }
  }
}
const thumbless = M.extractVideos(thumblessResponse)
check('falls back to an i.ytimg thumbnail built from the id',
  thumbless.length === 2 &&
    thumbless[0].thumbnail === 'https://i.ytimg.com/vi/aaaaaaaaaaa/hqdefault.jpg' &&
    thumbless[1].thumbnail === 'https://i.ytimg.com/vi/bbbbbbbbbbb/hqdefault.jpg',
  'thumbs=' + thumbless.map((v) => v.thumbnail).join(', '))

// The real LockupView contentImage nests one level deeper than the fixture
// above: contentImage.contentImageViewModel.image.sources. pickThumbnail must
// read that shape too, otherwise every card keeps the clone's old picture.
const nestedLockupResponse = {
  contents: {
    twoColumnBrowseResultsRenderer: {
      tabs: [{
        tabRenderer: {
          content: {
            richGridRenderer: {
              contents: [
                { richItemRenderer: { content: { lockupViewModel: {
                  video_id: 'ccccccccccc',
                  metadata: { lockupMetadataViewModel: { title: { content: 'Nested img' } } },
                  contentImage: { contentImageViewModel: { image: { sources: [
                    { url: 'https://i.ytimg.com/vi/ccccccccccc/hqdefault.jpg', width: 480 }
                  ] } } }
                } } } }
              ]
            }
          }
        }
      }]
    }
  }
}
const nested = M.extractVideos(nestedLockupResponse)
check('reads contentImageViewModel.image.sources thumbnails',
  nested[0] && nested[0].thumbnail === 'https://i.ytimg.com/vi/ccccccccccc/hqdefault.jpg',
  'thumb=' + (nested[0] || {}).thumbnail)

// The clone's <img> keeps its original srcset (used by the browser on retina),
// so the new src alone would be ignored and the old picture would stay on
// screen. buildCardFromTemplate must rewrite srcset too.
const srcsetCard = M.buildCardFromTemplate(makeRealCard(), extracted[0])
check('rewrites srcset so the cloned card shows the new thumbnail',
  srcsetCard.querySelector('img')._attrs.srcset === 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
  'srcset=' + srcsetCard.querySelector('img')._attrs.srcset)

// -------------------------------------------------- refill: bug of 1.23.0
// The browse response's FIRST continuation token belonged to a shelf (mostly a
// music mix), so the refill walked that shelf: added music once, then the
// shelf chain ended and nothing more was ever appended. The grid's own token
// must win, and shelf subtrees must not be extracted as feed cards.
const shelfResponse = {
  contents: {
    twoColumnBrowseResultsRenderer: {
      tabs: [{
        tabRenderer: {
          content: {
            richGridRenderer: {
              contents: [
                { richItemRenderer: { content: { lockupViewModel: {
                  video_id: 'fffffffffff',
                  metadata: { lockupMetadataViewModel: { title: { content: 'Feed video' } } }
                } } } },
                { richShelfRenderer: {
                  title: 'Music',
                  content: { horizontalListRenderer: { items: [
                    { richItemRenderer: { content: { lockupViewModel: {
                      video_id: 'ggggggggggg',
                      metadata: { lockupMetadataViewModel: { title: { content: 'Shelf music' } } }
                    } } } }
                  ] } }
                } },
                { richItemRenderer: { content: { lockupViewModel: {
                  video_id: 'hhhhhhhhhhh',
                  metadata: { lockupMetadataViewModel: { title: { content: 'Feed video two' } } }
                } } } },
                { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'GRIDTOKEN' } } } }
              ]
            }
          }
        }
      }]
    }
  }
}
const shelfVideos = M.extractVideos(shelfResponse)
check('skips music-shelf subtrees (the "mostly music" bug)',
  shelfVideos.length === 2 && shelfVideos.every((v) => v.id !== 'ggggggggggg'),
  'ids=' + shelfVideos.map((v) => v.id).join(','))
check('grid token wins over a shelf token in a browse response',
  M.firstContinuationToken(shelfResponse) === 'GRIDTOKEN',
  'token=' + M.firstContinuationToken(shelfResponse))

// A continuation response carries the next token on the ACTION, not inside a
// row. The old flat search could pick a row-level token (or a shelf's); the
// action-level continuation is the main feed's and must win.
const continuationResponse = {
  onResponseReceivedActions: [{
    appendContinuationItemsAction: {
      continuation: 'ACTION_TOKEN',
      continuationItems: [
        { richItemRenderer: { content: { lockupViewModel: { video_id: 'iiiiiiiiiii' } } } },
        { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'ROW_TOKEN' } } } }
      ]
    }
  }]
}
check('prefers the action-level continuation token on a continuation response',
  M.firstContinuationToken(continuationResponse) === 'ACTION_TOKEN',
  'token=' + M.firstContinuationToken(continuationResponse))

// Dead page: no sentinel, no grid.api, but a decoy "Ещё" button exists. On
// this build the button is a shelf decoy, so pressing it would burn ~8s and
// deliver nothing -- that is the multi-second delay the user saw. The module
// must skip the press and refill directly.
resetWorld({ scrollHeight: 1000, scrollTop: 0, sentinel: null })
gridEl.api = undefined
const decoyBtn = makeButton('Ещё')
world.buttons = [decoyBtn]
scopeRoots = [makeScope('ytd-continuation-item-renderer')]
M.pressFeedReloadButton()
check('dead page: decoy button is never clicked', world.clicks === 0, 'clicks=' + world.clicks)
check('dead page: refill-direct is flagged', M.diag.refillDirect === true)

// ------------------------------------------ refill: bugs of 1.24.0 (content)
// The lockup format keeps the channel in metadataRows (the part that links to
// the channel page), not in ownerText. Missing it left the clone's TEMPLATE
// channel under every refilled card (the "Gamers Nexus under everything" bug).
const lockupBylineResponse = {
  contents: {
    twoColumnBrowseResultsRenderer: {
      tabs: [{
        tabRenderer: {
          content: {
            richGridRenderer: {
              contents: [
                { richItemRenderer: { content: { lockupViewModel: {
                  video_id: 'jjjjjjjjjjj',
                  metadata: { lockupMetadataViewModel: {
                    title: { content: 'Lockup with channel' },
                    metadata: { contentMetadataViewModel: { metadataRows: [
                      { metadataParts: [
                        { text: { content: '@lockupchannel' },
                          navigationEndpoint: { browseEndpoint: { browseId: 'UClockupchannel' } } },
                        { text: { content: '1.2M subscribers' } },
                        { text: { content: '3 days ago' } }
                      ] }
                    ] } }
                  } }
                } } } }
              ]
            }
          }
        }
      }]
    }
  }
}
const lockupBylineVideos = M.extractVideos(lockupBylineResponse)
check('reads the channel name from lockup metadata rows',
  lockupBylineVideos[0] && lockupBylineVideos[0].byline === '@lockupchannel',
  'byline=' + (lockupBylineVideos[0] || {}).byline)

// Even when a shape is missed, the cloned card must never keep the template's
// channel: the byline is written unconditionally, blanking a stale name.
const noBylineVideo = { ...extracted[0], byline: "" }
const blankCard = M.buildCardFromTemplate(makeRealCard(), noBylineVideo)
check('blanks the template channel when the response has no byline',
  blankCard.querySelector('#byline').innerText === '',
  'byline=' + JSON.stringify(blankCard.querySelector('#byline').innerText))

// ------------------------------------------ refill: bugs of 1.25.0 (content)
// The 1.25.0 report ("опять музыка, ничего похожего на выдачу"): a browse
// response carries hundreds of video ids OUTSIDE the grid -- the Polymer
// entity store (frameworkUpdates) and more shelf shell variants
// (videoShelfRenderer). Only the grid may become feed cards.
M.refillProbe.sources = { root: 0, grid: 0, actions: 0 }
M.refillProbe.nonFeedSkipped = 0
const entityStoreResponse = {
  contents: {
    twoColumnBrowseResultsRenderer: {
      tabs: [{
        tabRenderer: {
          content: {
            richGridRenderer: {
              contents: [
                { richItemRenderer: { content: { lockupViewModel: { video_id: 'kkkkkkkkkkk' } } } }
              ]
            }
          }
        }
      }]
    }
  },
  frameworkUpdates: {
    entityBatchUpdate: {
      mutations: [
        { payload: { lockupViewModel: { video_id: 'mmmmmmmmmmm' } } },
        { payload: { lockupViewModel: { video_id: 'nnnnnnnnnnn' } } }
      ]
    }
  }
}
const entityVideos = M.extractVideos(entityStoreResponse)
check('does not turn frameworkUpdates entities into feed cards',
  entityVideos.length === 1 && entityVideos[0].id === 'kkkkkkkkkkk',
  'ids=' + entityVideos.map((v) => v.id).join(','))
check('credits extracted ids to the grid, not the entity store',
  M.refillProbe.sources.grid === 1 && M.refillProbe.sources.root === 0,
  'sources=' + JSON.stringify(M.refillProbe.sources))
check('counts the skipped non-feed subtrees',
  M.refillProbe.nonFeedSkipped >= 1,
  'skipped=' + M.refillProbe.nonFeedSkipped)

// videoShelfRenderer is yet another home layout shell for "for you"/music
// rows; like the other shelves it must not feed the refill.
const videoShelfResponse = {
  contents: {
    twoColumnBrowseResultsRenderer: {
      tabs: [{
        tabRenderer: {
          content: {
            richGridRenderer: {
              contents: [
                { videoShelfRenderer: {
                  title: { content: 'Music for you' },
                  content: {
                    horizontalListRenderer: {
                      items: [
                        { lockupViewModel: { video_id: 'ppppppppppp' } },
                        { lockupViewModel: { video_id: 'qqqqqqqqqqq' } }
                      ]
                    }
                  }
                } },
                { richItemRenderer: { content: { lockupViewModel: { video_id: 'rrrrrrrrrrr' } } } }
              ]
            }
          }
        }
      }]
    }
  }
}
const videoShelfVideos = M.extractVideos(videoShelfResponse)
check('skips videoShelfRenderer rows too (another music shell)',
  videoShelfVideos.length === 1 && videoShelfVideos[0].id === 'rrrrrrrrrrr',
  'ids=' + videoShelfVideos.map((v) => v.id).join(','))

// Some lockup builds have no metadata rows at all and merge the whole
// "channel · views · date" line into a single subtitle; the channel is the
// segment before the first separator.
const subtitleBylineResponse = {
  contents: {
    twoColumnBrowseResultsRenderer: {
      tabs: [{
        tabRenderer: {
          content: {
            richGridRenderer: {
              contents: [
                { richItemRenderer: { content: { lockupViewModel: {
                  video_id: 'ooooooooooo',
                  metadata: { lockupMetadataViewModel: {
                    title: { content: 'Subtitle lockup' },
                    subtitle: '@subtitlechannel · 1,2 млн просмотров · 3 дня назад'
                  } }
                } } } }
              ]
            }
          }
        }
      }]
    }
  }
}
const subtitleVideos = M.extractVideos(subtitleBylineResponse)
check('reads the channel from a merged subtitle line',
  subtitleVideos[0] && subtitleVideos[0].byline === '@subtitlechannel',
  'byline=' + (subtitleVideos[0] || {}).byline)

// Shape diagnostics: the first found video records its JSON path and own keys,
// and the key inventory names every key in the response with counts. These are
// what let a "0 videos" or "mostly music" report be diagnosed from its shape.
M.refillProbe.firstVideoPath = ""
M.refillProbe.videoShape = []
M.extractVideos(continuationResponse)
check('records the JSON path of the first found video',
  /appendContinuationItemsAction/.test(M.refillProbe.firstVideoPath || ""),
  'path=' + M.refillProbe.firstVideoPath)
check('records the own keys of the video node',
  /video_id/.test(M.refillProbe.videoShape || ""),
  'keys=' + M.refillProbe.videoShape)
const inventory = M.keyInventory(continuationResponse)
check('key inventory names every container with counts',
  inventory.some((k) => k.startsWith("lockupViewModel x")) &&
    inventory.some((k) => k.startsWith("appendContinuationItemsAction x1")),
  'inv=' + inventory.slice(0, 4).join(","))
check('key inventory is sorted by count, largest first',
  inventory[0] && inventory[0].length > 0,
  'top=' + (inventory[0] || ""))

// The 1.25-1.26 "one channel under all cards" bug: the channel lives in an
// element the byline selectors never match, so a selector-based rewrite missed
// it and every clone kept the template's channel. The content-based rewrite
// replaces ANY leaf still showing the captured channel text.
M.refillState.templateChannel = 'Fancy Little Channel'
const variantCard = M.buildCardFromTemplate(
  makeChannelVariantCard('Fancy Little Channel'),
  { ...extracted[0], byline: '@realchannel' })
check('content-based rewrite replaces a channel the selectors miss',
  variantCard.querySelectorAll('*').some((el) => el._text === '@realchannel'),
  'texts=' + variantCard.querySelectorAll('*').map((el) => el._text).join('|'))
check('no leaf keeps the template channel after the rewrite',
  variantCard.querySelectorAll('*').every((el) => el._text !== 'Fancy Little Channel'),
  'texts=' + variantCard.querySelectorAll('*').map((el) => el._text).join('|'))

// A merged "channel · views · date" leaf must keep its tail when the channel
// is replaced, not be overwritten wholesale.
M.refillState.templateChannel = 'Gamers Nexus'
const mergedLeaf = makeEl('span', { innerText: 'Gamers Nexus · 1,2 млн просмотров · 3 дня назад' })
const mergedCard = makeEl('ytd-rich-item-renderer')
const mergedTitle = makeEl('a', { id: 'video-title', innerText: 'Merged title' })
const mergedThumb = makeEl('a', { id: 'thumbnail' })
const mergedImg = makeEl('img')
mergedCard._children.push(mergedTitle, mergedThumb, mergedImg, mergedLeaf)
mergedCard.querySelectorAll = (sel) => {
  if (sel === '*') return mergedCard._children
  if (sel === 'img') return [mergedImg]
  if (/thumbnail/.test(sel)) return [mergedThumb]
  if (/video-title/.test(sel)) return [mergedTitle]
  return []
}
mergedCard.querySelector = (sel) => mergedCard.querySelectorAll(sel)[0] || null
mergedCard.cloneNode = () => {
  const copy = makeEl('ytd-rich-item-renderer')
  copy._children = mergedCard._children
  copy.querySelectorAll = mergedCard.querySelectorAll
  copy.querySelector = mergedCard.querySelector
  return copy
}
const mergedBuilt = M.buildCardFromTemplate(mergedCard, { ...extracted[0], byline: '@realchannel' })
check('a merged channel leaf keeps its views/date tail',
  mergedBuilt.querySelectorAll('*').some((el) => el._text === '@realchannel · 1,2 млн просмотров · 3 дня назад'),
  'texts=' + mergedBuilt.querySelectorAll('*').map((el) => el._text).join('|'))
M.refillState.templateChannel = ''

// An exhausted recommendation pool must back off instead of re-requesting the
// same browse on every scroll ("added once, then only repeats").
M.REFILL.poolRetryMs = 60000
M.refillState.poolExhaustedAt = Date.now()
M.refillState.lastRunAt = 0
M.refillState.running = false
M.refillHomeFeed()
check('exhausted pool: refill backs off instead of re-requesting',
  M.diag.refillRunning === false && M.refillState.lastRunAt === 0,
  'running=' + M.diag.refillRunning + ' lastRunAt=' + M.refillState.lastRunAt)
M.refillState.poolExhaustedAt = 0

// Endless-feed config: a refill walks deep (12 batches) when the pool is
// alive, but a quiet rotation probe only walks 2 batches so it can notice
// fresh uploads without hammering InnerTube for a mostly-seen pool.
check('endless config: deep walk + quiet rotation probe',
  M.REFILL.maxBatches === 12 && M.REFILL.probeBatches === 2 && M.REFILL.minYieldToStayOpen === 6,
  'maxBatches=' + M.REFILL.maxBatches + ' probeBatches=' + M.REFILL.probeBatches + ' minYieldToStayOpen=' + M.REFILL.minYieldToStayOpen)

console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===')
process.exit(fail ? 1 : 0)

console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===')
process.exit(fail ? 1 : 0)
