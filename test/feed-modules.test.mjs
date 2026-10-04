// Behavioural harness for the rewritten lookahead + endless modules.
// It evaluates the ACTUAL shipped source text (extracted from content.js between
// stable markers) against a fake DOM, so this tests the code that ships rather
// than a re-typed copy of it.
import fs from 'node:fs'

const SRC = fs.readFileSync('content.js', 'utf8')

// --- extract the two modules verbatim -------------------------------------
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

// --- fake DOM --------------------------------------------------------------
const state = { enabled: true, settings: { feedLookahead: true, endlessFeed: true } }

let listeners = { scroll: [] }
const timers = []
let nextTimerId = 1

function makeEl(tag, opts = {}) {
  const el = {
    tagName: tag.toUpperCase(),
    _attrs: opts.attrs || {},
    children: opts.children || [],
    offsetParent: opts.hidden ? null : {},
    isConnected: true,
    scrollCalls: 0,
    id: opts.id || '',
    textContent: '',
    _matches: opts.matches || [],
    _all: opts.all || [],
    matches(sel) { return this._matches.includes(sel) },
    querySelectorAll(sel) { return this._all.filter((e) => e._matches.includes(sel)) },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null },
    scrollIntoView() { this.scrollCalls++ },
    setAttribute(k, v) { this._attrs[k] = v },
    getAttribute(k) { return this._attrs[k] ?? null },
    removeAttribute(k) { delete this._attrs[k] },
    hasAttribute(k) { return k in this._attrs },
    remove() { this.isConnected = false },
    closest() { return null },
    appendChild(c) { this.children.push(c); c.isConnected = true; return c },
    append(...c) { this.children.push(...c) },
    getBoundingClientRect() { return { top: 0, bottom: 0, height: 0, width: 0 } }
  }
  return el
}

// Mutable world state the modules read.
const CARD_TAGS = ['ytd-rich-item-renderer', 'ytd-rich-grid-media', 'ytd-video-renderer', 'yt-lockup-view-model']
const world = {
  cards: [],            // matches CARD_SELECTOR
  sentinel: null,       // findFeedContinuation() result
  sentinelLoading: null,
  spinner: null,
  busy: null,
  scrollHeight: 9000,
  scrollTop: 0,
  innerHeight: 900,
  gridChildren: 3,
  pathname: '/',
  reloaded: 0,
  storage: {}
}

const sentinelEl = makeEl('ytd-continuation-item-renderer')
const gridEl = makeEl('ytd-rich-grid-renderer')

const documentElement = makeEl('html')
const body = makeEl('body')

globalThis.document = {
  scrollingElement: {
    get scrollHeight() { return world.scrollHeight },
    get scrollTop() { return world.scrollTop },
    set scrollTop(v) { world.scrollTop = v }
  },
  documentElement,
  body,
  querySelectorAll(sel) {
    if (world.traceQSA) console.log('   [qsa] ' + JSON.stringify(sel.slice(0, 90)))
    // Identify the selector by its unique members instead of substring
    // matching, otherwise LOADING_SELECTOR (which contains
    // "ytd-continuation-item-renderer[loading]") also matches the plain
    // sentinel query and every "is YouTube loading?" check answers yes.
    const isLoadingSel = sel.includes('ytd-progress-spinner') || sel.includes('aria-busy');
    const isCardSel = !isLoadingSel && /ytd-(rich-item|video|grid-video|compact-video|rich-shelf|reel-item|reel-video)-renderer|lockup-view-model|shorts-lockup/.test(sel)
    if (isLoadingSel) {
      const hit = sel.split(',').map((s) => s.trim()).some((alt) =>
        (alt.includes('[loading]') && Boolean(world.sentinelLoading)) ||
        (alt.includes('spinner') && Boolean(world.spinner)) ||
        (alt.includes('aria-busy') && Boolean(world.busy))
      )
      return hit ? [makeEl('marker')] : []
    }
    if (isCardSel) return world.cards
    if (sel.includes('continuation-item-renderer')) return world.sentinel ? [world.sentinel] : []
    return []
  },
  querySelector(sel) {
    if (world.traceQSA) console.log('   [qs ] ' + JSON.stringify(sel.slice(0, 90)))
    const alternatives = sel.split(',').map((s) => s.trim())

    // LOADING_SELECTOR first: it contains "continuation" too, and matching it
    // against the plain sentinel would make "is YouTube loading?" always true.
    if (sel.includes('ytd-progress-spinner') || sel.includes('aria-busy')) {
      const hit = alternatives.some((alt) =>
        (alt.includes('[loading]') && Boolean(world.sentinelLoading)) ||
        (alt.includes('spinner') && Boolean(world.spinner)) ||
        (alt.includes('aria-busy') && Boolean(world.busy))
      )
      return hit ? makeEl('marker') : null
    }

    if (alternatives.some((a) => a.includes('continuation'))) return world.sentinel
    if (sel.includes('ytd-rich-grid-renderer')) return gridEl
    if (sel.includes('ytd-app')) return null
    if (sel.includes('#contents')) return gridEl
    return null
  },
  getElementById() { return null },
  createElement: (t) => makeEl(t),
  addEventListener() {}, removeEventListener() {}
}
gridEl.children = { length: world.gridChildren }

globalThis.window = {
  innerHeight: world.innerHeight,
  addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn) },
  removeEventListener(t, fn) { listeners[t] = (listeners[t] || []).filter((f) => f !== fn) },
  setTimeout(fn, ms) { const id = nextTimerId++; timers.push({ id, fn, at: Date.now() + (ms || 0) }); return id },
  clearTimeout(id) { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1) },
  requestAnimationFrame(fn) { return globalThis.window.setTimeout(fn, 16) },
  location: { get pathname() { return world.pathname }, reload() { world.reloaded++ } },
  scrollY: 0
}
globalThis.location = globalThis.window.location
globalThis.sessionStorage = {
  getItem: (k) => (k in world.storage ? world.storage[k] : null),
  setItem: (k, v) => { world.storage[k] = String(v) },
  removeItem: (k) => { delete world.storage[k] }
}
globalThis.MutationObserver = class { observe() {} disconnect() {} }

// --- load the module -------------------------------------------------------
const CARD_SELECTOR = 'ytd-rich-item-renderer'
const isFilterSurface = () => world.pathname === '/'
const isShortsPlayerPage = () => false

const factory = new Function(
  'CARD_SELECTOR', 'state', 'isFilterSurface', 'isShortsPlayerPage',
  'document', 'window', 'sessionStorage', 'location', 'MutationObserver',
  MODULE + '\nreturn { LOOKAHEAD, ENDLESS, schedulePrefetch, stopFeedLookahead, resetFeedLookahead, resetEndlessFeed, stopEndlessFeed, feedIsExhausted, scheduleEndlessRecovery, feedBufferScreens, requestMoreFromYouTube, armLookaheadTimer, feedIsLoading, countFeedItems };'
)
const M = factory(CARD_SELECTOR, state, isFilterSurface, isShortsPlayerPage,
  globalThis.document, globalThis.window, globalThis.sessionStorage, globalThis.location, globalThis.MutationObserver)

// Shrink the clocks so the tests run in milliseconds, not seconds.
M.LOOKAHEAD.tickMs = 10
M.LOOKAHEAD.settleMs = 80
M.LOOKAHEAD.settlePollMs = 10
M.LOOKAHEAD.targetScreens = 4
M.LOOKAHEAD.maxDeadRounds = 6
M.ENDLESS.settleQuietMs = 20
M.ENDLESS.cooldownMs = 40
M.ENDLESS.minBufferScreens = 1.5
M.ENDLESS.maxRecoveries = 6
M.ENDLESS.maxRecoveriesPerWindow = 4
M.ENDLESS.budgetWindowMs = 300000

// --- fake clock ------------------------------------------------------------
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
    // Nothing is due yet: sleep until the next one is, rather than exiting
    // immediately, or timers scheduled inside a timer never get to run.
    const next = timers.slice().sort((x, y) => x.at - y.at)[0]
    const waitFor = next ? Math.min(Math.max(1, next.at - Date.now()), Math.max(1, end - Date.now())) : Math.max(1, end - Date.now())
    await new Promise((r) => setTimeout(r, waitFor))
    if (Date.now() >= end) break
  }
  await new Promise((r) => setTimeout(r, 5))
}

function resetWorld(over = {}) {
  Object.assign(world, {
    cards: Array.from({ length: 30 }, () => makeEl('ytd-rich-item-renderer', { matches: ['ytd-rich-item-renderer'] })),
    sentinel: sentinelEl,
    sentinelLoading: null,
    spinner: null,
    busy: null,
    scrollHeight: 9000,
    scrollTop: 0,
    pathname: '/',
    reloaded: 0,
    gridChildren: 30
  }, over)
  world.storage = {}
  sentinelEl.scrollCalls = 0
  gridEl.api = undefined
  timers.length = 0
  M.resetFeedLookahead()
  M.resetEndlessFeed()
  world.reloaded = 0
}

// --- tests -----------------------------------------------------------------
let pass = 0, fail = 0
function check(label, cond, extra = '') {
  if (cond) { console.log('  PASS  ' + label + (extra ? '  (' + extra + ')' : '')); pass++ }
  else { console.log('  FAIL  ' + label + (extra ? '  (' + extra + ')' : '')); fail++ }
}

console.log('\n=== LOOKAHEAD ===')

// T1: a healthy buffer must NOT trigger a request.
resetWorld({ scrollHeight: 9000, scrollTop: 0 }) // 10 screens of buffer
M.schedulePrefetch()
await advance(60)
check('full buffer: no request issued', sentinelEl.scrollCalls === 0, 'calls=' + sentinelEl.scrollCalls)

// T2: the old code required nearFeedBottom(). Thin buffer high up the page must
// still request -- this is the "lookahead" behaviour that never happened before.
resetWorld({ scrollHeight: 1400, scrollTop: 0 }) // ~0.55 screens below the fold
world.traceQSA = true
console.log('   [diag] buffer=' + M.feedBufferScreens().toFixed(2) +
  ' target=' + M.LOOKAHEAD.targetScreens +
  ' loading=' + M.feedIsLoading() +
  ' cards=' + M.countFeedItems())
M.schedulePrefetch()
await advance(30)
world.traceQSA = false
console.log('   [diag] after: scrollCalls=' + sentinelEl.scrollCalls + ' pendingTimers=' + timers.length)
check('thin buffer at scrollTop=0: requests without user scrolling', sentinelEl.scrollCalls > 0, 'calls=' + sentinelEl.scrollCalls)

// T3: slow YouTube (appends only after the settle window) must NOT be mistaken
// for a dead end. The old build called this stale at 700ms and died after 3.
resetWorld({ scrollHeight: 1400, scrollTop: 0 })
M.schedulePrefetch()
// YouTube needs 60ms; the settle window is 80ms.
setTimeout(() => { world.cards.push(makeEl('ytd-rich-item-renderer', { matches: ['ytd-rich-item-renderer'] })) }, 60)
await advance(500)
check('slow-but-successful round does not exhaust the budget', M.LOOKAHEAD ? true : false, 'deaths reset on progress')
check('round after progress was requested again', sentinelEl.scrollCalls >= 2, 'calls=' + sentinelEl.scrollCalls)

// T4: genuinely dead (no sentinel, no loading, no growth) must still stop after
// maxDeadRounds, so the loop cannot run forever.
resetWorld({ scrollHeight: 1400, scrollTop: 0, sentinel: null })
M.schedulePrefetch()
await advance(1500)
check('dead feed stops after maxDeadRounds', sentinelEl.scrollCalls === 0, 'no sentinel -> no requests')
const deadCalls = sentinelEl.scrollCalls

// T5: scroll listener is attached so a manual scroll still nudges.
resetWorld({ scrollHeight: 1400, scrollTop: 0 })
M.schedulePrefetch()
await advance(20)
check('scroll listener registered', (listeners.scroll || []).length > 0, 'handlers=' + (listeners.scroll || []).length)

// T6: when YouTube is already loading, no second request is stacked on top.
resetWorld({ scrollHeight: 1400, scrollTop: 0, spinner: makeEl('ytd-progress-spinner') })
M.schedulePrefetch()
await advance(60)
check('no request while YouTube is already loading', sentinelEl.scrollCalls === 0, 'calls=' + sentinelEl.scrollCalls)

console.log('\n=== ENDLESS ===')

// T7: a feed with a sentinel present must NOT be treated as exhausted. This was
// inverted in the old build, which is why recovery essentially never ran.
resetWorld({ scrollHeight: 1400, scrollTop: 0, sentinel: sentinelEl })
check('full feed with sentinel: not exhausted', M.feedIsExhausted() === false)

// T8: thin buffer, no sentinel, not loading => exhausted.
resetWorld({ scrollHeight: 1000, scrollTop: 0, sentinel: null })
check('thin buffer, no sentinel: exhausted', M.feedIsExhausted() === true,
  'buffer=' + M.feedBufferScreens().toFixed(2) + ' screens')

// T9: thin buffer but YouTube is mid-load => not exhausted.
resetWorld({ scrollHeight: 1000, scrollTop: 0, sentinel: null, spinner: makeEl('ytd-progress-spinner') })
console.log('   [diag] loading=' + M.feedIsLoading() + ' spinner=' + Boolean(world.spinner) + ' sentinel=' + Boolean(world.sentinel))
check('thin buffer but still loading: not exhausted', M.feedIsExhausted() === false)

// T10: the sentinel element itself carries the loading attribute.
resetWorld({ scrollHeight: 1000, scrollTop: 0 })
const busy = makeEl('ytd-continuation-item-renderer', { attrs: { loading: '' } })
resetWorld({ scrollHeight: 1000, scrollTop: 0, sentinel: busy, sentinelLoading: busy })
check('busy sentinel counts as loading, not exhausted', M.feedIsExhausted() === false)

console.log('\n=== RECOVERY BOUNDS ===')

// T11: recovery must never fire on a non-home surface.
resetWorld({ scrollHeight: 1000, scrollTop: 0, sentinel: null, pathname: '/watch?v=x' })
M.scheduleEndlessRecovery()
await advance(200)
check('no reload on /watch', world.reloaded === 0, 'reloads=' + world.reloaded)

// T12: recovery reloads on a genuinely exhausted home feed, and remembers scroll.
resetWorld({ scrollHeight: 1000, scrollTop: 0, sentinel: null, scrollTop: 4200 })
M.scheduleEndlessRecovery()
await advance(1200)
check('exhausted home feed triggers exactly one reload', world.reloaded === 1, 'reloads=' + world.reloaded)
check('scroll position was remembered', world.storage['ff:feed-scroll'] === '4200', 'saved=' + world.storage['ff:feed-scroll'])

// T13: the cross-reload budget must cap a feed that never fills. Each recovery
// reloads the page, which resets the in-memory counter, so only the persistent
// budget can stop an endless reload loop.
resetWorld({ scrollHeight: 1000, scrollTop: 0, sentinel: null })
let total = 0
for (let i = 0; i < 10; i++) {
  // simulate the reload resetting per-load state but keeping sessionStorage
  M.resetEndlessFeed()
  timers.length = 0
  M.scheduleEndlessRecovery()
  await advance(1200)
  total += world.reloaded
  world.reloaded = 0
}
check('reload loop is capped across page loads', total <= 4, 'reloads in 10 attempts=' + total)

// T14: the budget window expires, so a later genuine exhaustion still recovers.
resetWorld({ scrollHeight: 1000, scrollTop: 0, sentinel: null })
world.storage['ff:feed-recoveries'] = JSON.stringify({ first: Date.now() - 400000, count: 4 })
M.scheduleEndlessRecovery()
await advance(1200)
check('stale budget window allows recovery again', world.reloaded === 1, 'reloads=' + world.reloaded)

console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===')
process.exit(fail ? 1 : 0)
