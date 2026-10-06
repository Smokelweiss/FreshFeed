// Behavioural harness for the background feed preload module.
// It evaluates the ACTUAL shipped source text (extracted from content.js between
// stable markers) against a fake DOM and a fake clock, so this tests the code
// that ships rather than a re-typed copy of it.
import fs from 'node:fs'

const SRC = fs.readFileSync('content.js', 'utf8')

const startMarker = '  // --- Background feed preload'
const endMarker = '  function connectHome() {'
const a = SRC.indexOf(startMarker)
const b = SRC.indexOf(endMarker)
if (a < 0 || b < 0 || b <= a) {
  console.error('markers not found')
  process.exit(1)
}
const MODULE = SRC.slice(a, b)
console.log('extracted module: ' + MODULE.split('\n').length + ' lines\n')

const state = { enabled: true, settings: { bgPreload: true } }

const timers = []
let nextTimerId = 1

function makeEl(tag, opts = {}) {
  const el = {
    tagName: tag.toUpperCase(),
    _attrs: opts.attrs || {},
    id: opts.id || '',
    _text: opts.innerText || '',
    get innerText() { return this._text },
    set innerText(v) { this._text = v },
    get textContent() { return this._text },
    set textContent(v) { this._text = v },
    disabled: Boolean(opts.disabled),
    isConnected: true,
    offsetParent: opts.hidden ? null : {},
    _matches: opts.matches || [],
    _children: opts.children || [],
    style: { transform: '', opacity: '' },
    matches(sel) { return this._matches.includes(sel) },
    querySelectorAll(sel) { return this._children.filter((c) => c._matches.includes(sel)) },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null },
    get children() { return this._children },
    scrollIntoView() {},
    click() {},
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
  scrollHeight: 9000,
  scrollTop: 0,
  innerHeight: 900,
  pathname: '/',
  storage: {}
}

const body = makeEl('body')
const documentElement = makeEl('html')
const gridEl = makeEl('ytd-rich-grid-renderer')

globalThis.document = {
  scrollingElement: {
    get scrollHeight() { return world.scrollHeight },
    get scrollTop() { return world.scrollTop },
    set scrollTop(v) { world.scrollTop = v }
  },
  documentElement,
  body,
  querySelectorAll(sel) {
    const isCardSel = /ytd-(rich-item|video|grid-video|compact-video|rich-shelf|reel-item|reel-video)-renderer|lockup-view-model|shorts-lockup/.test(sel)
    if (isCardSel) return world.cards
    if (sel.includes('continuation')) return world.sentinel ? [world.sentinel] : []
    return []
  },
  querySelector(sel) {
    const alternatives = sel.split(',').map((s) => s.trim())
    if (alternatives.some((x) => x.includes('continuation'))) return world.sentinel
    if (sel.includes('ytd-rich-grid-renderer')) return gridEl
    if (sel.includes('#contents')) return gridEl
    return null
  },
  getElementById() { return null },
  createElement: (t) => makeEl(t),
  addEventListener() {}, removeEventListener() {}
}

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
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'test-agent' }, writable: true })

const CARD_SELECTOR = 'ytd-rich-item-renderer'
const isFilterSurface = () => world.pathname === '/'
const isShortsPlayerPage = () => false
const homeActive = true

const diagWrites = []
const browserStub = {
  storage: { local: { set: (o) => { diagWrites.push(o); return Promise.resolve(); } } }
}

const factory = new Function(
  'CARD_SELECTOR', 'state', 'isFilterSurface', 'isShortsPlayerPage', 'homeActive', 'browser',
  'document', 'window', 'sessionStorage', 'location', 'MutationObserver',
  MODULE + '\nreturn { PRELOAD, diag, flushDiag, resetPreload, stopPreload, startPreload, runPreload, nudgeNativeContinuation, findFeedSentinel, feedItemCount, preloadScreensPending };'
)
const M = factory(CARD_SELECTOR, state, isFilterSurface, isShortsPlayerPage, homeActive, browserStub,
  globalThis.document, globalThis.window, globalThis.sessionStorage, globalThis.location, globalThis.MutationObserver)

// Fast clocks for the tests; the shipping values are larger so a real page
// loads at a gentle, human-like pace and never free-runs.
const shippingPreload = { ...M.PRELOAD }
M.PRELOAD.tickMs = 10
M.PRELOAD.settleMs = 40
M.PRELOAD.settlePollMs = 10
M.PRELOAD.targetScreens = 3
M.PRELOAD.maxDeadRounds = 5
M.PRELOAD.largeBufferWaitMs = 10
M.PRELOAD.growthRetryMs = 10
M.PRELOAD.nudgeHoldMs = 20

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

let pass = 0
let fail = 0
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS  ' + name) }
  else { fail += 1; console.log('! FAIL  ' + name + (detail ? '   [' + detail + ']' : '')) }
}

// --- Config sanity ---------------------------------------------------------
check('PRELOAD defaults are sane',
  shippingPreload.enabled === true && shippingPreload.tickMs >= 100 &&
  shippingPreload.settleMs >= 300 && shippingPreload.targetScreens >= 50 &&
  shippingPreload.maxDeadRounds >= 3 && shippingPreload.pauseAfterDeadMs >= 1000 &&
  // nudgeHoldMs must exceed one frame (~16 ms) or IntersectionObserver never
  // sees the displaced sentinel - see the regression test below.
  shippingPreload.nudgeHoldMs >= 100,
  JSON.stringify(shippingPreload))

// --- Feed item counting ----------------------------------------------------
world.cards = [makeEl('ytd-rich-item-renderer'), makeEl('ytd-rich-item-renderer'), makeEl('ytd-rich-item-renderer')]
check('feedItemCount counts feed cards', M.feedItemCount() === 3, 'count=' + M.feedItemCount())
world.cards = []

// --- Sentinel discovery ----------------------------------------------------
const sentinelEl = makeEl('ytd-continuation-item-renderer')
world.sentinel = sentinelEl
check('findFeedSentinel finds the continuation sentinel',
  M.findFeedSentinel() === sentinelEl,
  'got ' + (M.findFeedSentinel() && M.findFeedSentinel().tagName))
world.sentinel = null
check('findFeedSentinel returns null when the grid has no sentinel',
  M.findFeedSentinel() === null,
  'got ' + M.findFeedSentinel())

// --- Nudge (invisible wake of YouTube pagination) -------------------------
world.sentinel = sentinelEl
check('nudge translates the sentinel into the viewport without scrolling the page',
  M.nudgeNativeContinuation() === true &&
    /^translateY\(-?\d+px\)$/.test(sentinelEl.style.transform) &&
    sentinelEl.style.opacity === '0' &&
    world.scrollTop === 0 && M.diag.preloadHook === 'sentinel' &&
    M.diag.preloadHookTag === 'ytd-continuation-item-renderer',
  'transform=' + sentinelEl.style.transform + ' opacity=' + sentinelEl.style.opacity +
    ' hook=' + M.diag.preloadHook + ' tag=' + M.diag.preloadHookTag)

// Regression for the rAF-restore bug: the displacement must survive at least one
// full frame. IntersectionObserver computes intersections during the frame's
// render step, which runs AFTER rAF callbacks, so restoring inside rAF undid the
// displacement before the observer could ever see the sentinel in the viewport.
// That is why only about half the nudges used to register.
await advance(5)
check('nudge holds the displacement across frames instead of restoring in rAF',
  /^translateY\(-?\d+px\)$/.test(sentinelEl.style.transform) && sentinelEl.style.opacity === '0',
  'transform=' + sentinelEl.style.transform + ' opacity=' + sentinelEl.style.opacity)
await advance(40)
check('nudge restores the transform and opacity after the hold',
  sentinelEl.style.transform === '' && sentinelEl.style.opacity === '',
  'transform=' + JSON.stringify(sentinelEl.style.transform) +
    ' opacity=' + JSON.stringify(sentinelEl.style.opacity))

world.sentinel = null
M.diag.preloadHook = ''
check('nudge reports no hook when this build has no sentinel',
  M.nudgeNativeContinuation() === false && M.diag.preloadHook === 'none',
  'hook=' + M.diag.preloadHook)
world.sentinel = sentinelEl

// --- Buffer geometry -------------------------------------------------------
// scrollHeight 9000, fold 900 -> (9000 - 900) / 900 = 9 screens pending.
check('preloadScreensPending measures buffer below the fold',
  Math.abs(M.preloadScreensPending() - 9) < 0.01,
  'screens=' + M.preloadScreensPending())

// --- CRITICAL: the page must never move during a preload cycle ------------
// This is the whole point of the feature. A real scroll is visible to the
// user, so the preload must rely only on the transform nudge. Run a full
// cycle of rounds and assert the viewport position never changed.
world.sentinel = sentinelEl
world.scrollTop = 200 // the user has already scrolled a bit; that must survive
world.scrollHeight = 3000
const scrollBefore = world.scrollTop
M.resetPreload()
M.startPreload()
// Let several rounds run, including dead ones that must not fall back to a scroll.
for (let i = 0; i < 8; i++) await advance(120)
check('preload never scrolls the page during any round',
  world.scrollTop === scrollBefore,
  'scrollTop went ' + scrollBefore + ' -> ' + world.scrollTop)
check('preload never fell back to the removed scroll strategy',
  M.diag.scrollAttempts === 0,
  'scrollAttempts=' + M.diag.scrollAttempts)
M.stopPreload('test')
world.scrollTop = 0
M.resetPreload()
// Drain the drift timers left over from the rounds above. They fire late and
// would otherwise attribute this scrollTop reset to the last nudge of the test.
await advance(500)
M.diag.preloadScrollDriftPx = 0

// The "page never moved" claim must be measured, not asserted. Run a nudge and
// confirm the drift counter stays at zero, then simulate a scroll and confirm it
// is reported honestly instead of hidden behind a hardcoded "never".
world.sentinel = sentinelEl
world.scrollTop = 0
M.nudgeNativeContinuation()
await advance(200)
check('nudge measures zero scroll drift when the page does not move',
  (M.diag.preloadScrollDriftPx || 0) === 0,
  'drift=' + M.diag.preloadScrollDriftPx)
world.scrollTop = 0
M.diag.preloadScrollDriftPx = 0
M.nudgeNativeContinuation() // captures scrollTopBefore = 0
world.scrollTop = 300       // a scroll that happens DURING the hold window
await advance(200)
check('nudge reports real scroll drift instead of assuming "never"',
  (M.diag.preloadScrollDriftPx || 0) === 300,
  'drift=' + M.diag.preloadScrollDriftPx)
world.scrollTop = 0
M.resetPreload()

// --- Gates ---------------------------------------------------------------
M.resetPreload()
world.pathname = '/'
world.scrollHeight = 3000 // buffer 2.33 < target, so a run would nudge

state.enabled = false
M.startPreload()
check('startPreload holds when the master switch is off',
  M.diag.preloadActive === false && M.diag.preloadGate === 'master switch is OFF',
  'gate=' + M.diag.preloadGate)
state.enabled = true

state.settings.bgPreload = false
M.startPreload()
check('startPreload holds when the preload toggle is off',
  M.diag.preloadActive === false && M.diag.preloadGate === 'background preload toggle is OFF',
  'gate=' + M.diag.preloadGate)
state.settings.bgPreload = true

world.pathname = '/watch'
M.startPreload()
check('startPreload holds off the home page',
  M.diag.preloadActive === false && M.diag.preloadGate === 'not the home feed',
  'gate=' + M.diag.preloadGate)
world.pathname = '/'

// --- A live round: nudge -> YouTube appends -> growth ----------------------
M.resetPreload()
M.startPreload()
check('startPreload arms the background loop on the home feed',
  M.diag.preloadActive === true && M.diag.preloadGate === '',
  'active=' + M.diag.preloadActive)
await advance(30)
check('a round nudged the sentinel and counted itself',
  M.diag.preloadRounds >= 1 && M.diag.preloadHook === 'sentinel',
  'rounds=' + M.diag.preloadRounds + ' hook=' + M.diag.preloadHook)
// Simulate YouTube appending content after the nudge.
world.cards.push(makeEl('ytd-rich-item-renderer'))
// Advance just enough for the next poll to detect growth (poll at ~40ms after nudge)
// Nudge at ~10ms, polls at ~20,30,40ms. Card added at 30ms. Next poll at 40ms detects growth.
await advance(20)
check('a round that grew the feed clears the dead counter',
  M.diag.preloadGrowth >= 1 && M.diag.preloadDeadRounds === 0,
  'growth=' + M.diag.preloadGrowth + ' dead=' + M.diag.preloadDeadRounds)
M.stopPreload('test'); // freeze the loop before later rounds re-accumulate

// --- Dead rounds -> quiet pause + exhaustion --------------------------------
M.resetPreload()
world.cards = []
M.startPreload()
await advance(260)
check('rounds that grow nothing are counted and reach a pause',
  M.diag.preloadDeadRounds >= M.PRELOAD.maxDeadRounds &&
    M.diag.preloadExhausted === true,
  'dead=' + M.diag.preloadDeadRounds + ' exhausted=' + M.diag.preloadExhausted +
    ' (max ' + M.PRELOAD.maxDeadRounds + ')')

// --- An unused buffer does NOT hold the loop before the feed is exhausted -----
// Belongs to the current requirement: preload must keep growing the whole feed
// out of sight, not stop after a shallow target. A large buffer is not a reason
// to pause when there is still pagination to wake.
M.resetPreload()
world.scrollHeight = 9000 // 9 screens; well past the 3-screen test target
M.startPreload()
await advance(30)
check('a deep buffer does not hold the loop before the feed is exhausted',
  M.diag.preloadRounds >= 1,
  'rounds=' + M.diag.preloadRounds)
world.scrollHeight = 3000

// --- Reset / stop ----------------------------------------------------------
M.diag.preloadRounds = 7
M.diag.preloadGrowth = 3
M.diag.preloadHook = 'sentinel'
M.resetPreload()
check('resetPreload zeroes the per-page budget',
  M.diag.preloadActive === false && M.diag.preloadRounds === 0 &&
  M.diag.preloadGrowth === 0 && M.diag.preloadHook === '',
  'active=' + M.diag.preloadActive + ' rounds=' + M.diag.preloadRounds)

M.startPreload()
M.stopPreload('stopped for a reason')
check('stopPreload records why it stopped',
  M.diag.preloadActive === false && M.diag.preloadGate === 'stopped for a reason',
  'gate=' + M.diag.preloadGate)

// --- Diagnostics persistence -----------------------------------------------
M.diag.preloadRounds = 4
M.diag.checked = 11
M.diag.hidden = 3
diagWrites.length = 0
M.flushDiag(true)
// Enhanced diagnostics check
check('flushDiag includes enhanced diagnostic fields',
  diagWrites.length === 1 &&
  diagWrites[0].feedDiag &&
  typeof diagWrites[0].feedDiag.totalScans === 'number' &&
  typeof diagWrites[0].feedDiag.totalCardsScanned === 'number' &&
  typeof diagWrites[0].feedDiag.bufferScreens === 'number' &&
  typeof diagWrites[0].feedDiag.isIntersectionObserverBuild === 'boolean' &&
  typeof diagWrites[0].feedDiag.continuationSentinelPresent === 'boolean' &&
  typeof diagWrites[0].feedDiag.preloadSetting === 'boolean' &&
  typeof diagWrites[0].feedDiag.preloadScrollDriftPx === 'number' &&
  typeof diagWrites[0].feedDiag.preloadHookTag === 'string',
  'missing enhanced fields')

// Additional check for strategy tracking
check('strategy tracking works',
  M.diag.nudgeAttempts > 0 || M.diag.scrollAttempts > 0,
  'no strategy attempts recorded')

check('strategy success tracking works',
  M.diag.nudgeSuccesses > 0 || M.diag.scrollSuccesses > 0,
  'no strategy successes recorded')

check('final persistence check',
  diagWrites.length === 1 && diagWrites[0].feedDiag &&
  diagWrites[0].feedDiag.preloadRounds === 4 &&
  diagWrites[0].feedDiag.checked === 11,
  'writes=' + diagWrites.length)

console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===')
process.exit(fail ? 1 : 0)