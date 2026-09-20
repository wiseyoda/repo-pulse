import {
  feedTotals,
  magnitudeWidth,
  mergeFeed,
  numberDiff,
  relativeTime,
  rollupCommits,
  splitPath,
} from './lib.js'

const HOT_MS = 60_000
const HEAT_MS = 15 * 60_000
const FEED_LIMIT = 400
const TREE_LIMIT = 500
const GROUP_MS = 5 * 60_000
const SCROLLED_PX = 24
const THEMES = ['auto', 'light', 'dark']

const state = {
  repo: null,
  worktrees: [],
  itemPattern: '\\b[A-Z]{1,4}-\\d+\\b',
  cmux: false,
  edits: [],
  commits: [],
  heads: [],
  snapshots: new Map(),
  lastTouch: new Map(), // `${wt}\0${path}` -> ts of last edit event
  seen: new Set(),
  window: 3_600_000,
  filter: '',
  wtFilter: null,
  panel: 'feed',
  selectedKey: null,
  flashIds: new Set(),
  pending: 0, // live rows not yet rendered because the reader has scrolled down
  drawer: null, // { kind: 'file'|'commit', wt, path?, sha? }
  skew: 0,
  loaded: false,
  online: false,
  lastEventAt: 0,
}

const $ = (id) => document.getElementById(id)
const els = {
  favicon: $('favicon'),
  live: $('live'),
  repo: $('repo'),
  root: $('root'),
  wts: $('wts'),
  window: $('window'),
  filter: $('filter'),
  tabs: $('tabs'),
  tabFeed: $('tab-feed'),
  tabTree: $('tab-tree'),
  tabItems: $('tab-items'),
  feed: $('feed'),
  feedCount: $('feed-count'),
  feedSum: $('feed-sum'),
  newpill: $('newpill'),
  tree: $('tree'),
  treeCount: $('tree-count'),
  items: $('items'),
  itemsCount: $('items-count'),
  status: $('status'),
  theme: $('theme'),
  drawer: $('drawer'),
  drawerTitle: $('drawer-title'),
  drawerStats: $('drawer-stats'),
  drawerFiles: $('drawer-files'),
  cmuxBtn: $('cmux-btn'),
  drawerClose: $('drawer-close'),
  diff: $('diff'),
}

const now = () => Date.now() + state.skew
const since = () => (state.window ? now() - state.window : 0)
const touchKey = (wt, path) => `${wt}\0${path}`
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
// Rows show h:mm:ss with no day period; the sticky group header above them carries "AM"/"PM".
const fmtTime = (ts) => {
  const d = new Date(ts)
  const hh = d.getHours() % 12 || 12
  return `${hh}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}
const fmtGroup = (ts) =>
  new Date(Math.floor(ts / GROUP_MS) * GROUP_MS).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  })
const fmtSigned = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0')

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue
    if (k === 'class') el.className = v
    else if (k === 'style') el.style.cssText = v
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else if (k === 'dataset') Object.assign(el.dataset, v)
    else el.setAttribute(k, v === true ? '' : v)
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue
    el.append(c instanceof Node ? c : document.createTextNode(String(c)))
  }
  return el
}

// --- data ------------------------------------------------------------------

function ingest(ev, { live = false } = {}) {
  if (state.seen.has(ev.id)) return false
  state.seen.add(ev.id)
  if (ev.type === 'edit') {
    state.edits.push(ev)
    state.lastTouch.set(touchKey(ev.wt, ev.path), ev.ts)
  } else if (ev.type === 'commit') state.commits.push(ev)
  else state.heads.push(ev)
  if (live) {
    state.flashIds.add(ev.id)
    state.lastEventAt = ev.ts
  }
  return true
}

function replaceState(s) {
  state.repo = s.repo
  state.worktrees = s.worktrees
  state.itemPattern = s.itemPattern
  state.cmux = s.cmux
  state.skew = s.now - Date.now()
  state.edits = []
  state.commits = []
  state.heads = []
  state.seen = new Set()
  state.lastTouch = new Map()
  for (const e of s.edits) ingest(e)
  for (const c of s.commits) ingest(c)
  for (const hd of s.heads) ingest(hd)
  state.snapshots = new Map(s.snapshots.map((sn) => [sn.wt.id, sn]))
  state.lastEventAt = Math.max(
    0,
    ...state.edits.map((e) => e.ts),
    ...state.commits.map((c) => c.ts),
  )
  if (state.wtFilter && !state.worktrees.some((w) => w.id === state.wtFilter)) state.wtFilter = null
  state.loaded = true
}

function matches(text) {
  const q = state.filter.trim().toLowerCase()
  return !q || text.toLowerCase().includes(q)
}

const inWt = (wtId) => !state.wtFilter || wtId === state.wtFilter

function wtLabel(wtId) {
  if (state.worktrees.length < 2) return ''
  const wt = state.worktrees.find((w) => w.id === wtId)
  return wt ? (wt.branch ?? wt.head?.slice(0, 7) ?? '?') : '?'
}

function feedRows() {
  return mergeFeed(state.edits, state.commits, state.heads, since()).filter(
    (r) =>
      inWt(r.wt) &&
      (r.type === 'edit'
        ? matches(r.path)
        : r.type === 'commit'
          ? matches(`${r.commit.subject} ${r.commit.sha}`)
          : true),
  )
}

// --- rendering (coalesced into one frame) --------------------------------------

const dirty = new Set()
let scheduled = false
function flush() {
  scheduled = false
  const parts = new Set(dirty)
  dirty.clear()
  if (parts.has('header')) renderHeader()
  if (parts.has('feed')) renderFeed()
  if (parts.has('tree')) renderTree()
  if (parts.has('items')) renderItems()
  if (parts.has('status')) renderStatus()
}
// One render per frame however many events arrive. Frames stop in a background tab, so a
// timer takes over there and the page is current the moment it is shown again.
function invalidate(...parts) {
  for (const p of parts) dirty.add(p)
  if (scheduled) return
  scheduled = true
  if (document.hidden) setTimeout(flush, 0)
  else requestAnimationFrame(flush)
}
const renderAll = () => invalidate('header', 'feed', 'tree', 'items', 'status')

function renderHeader() {
  if (!state.repo) return
  els.repo.textContent = state.repo.name
  els.root.textContent = state.repo.root.replace(/^\/Users\/[^/]+/, '~')
  const t = now()
  els.wts.replaceChildren(
    ...state.worktrees.map((wt) => {
      const hot = state.edits.some((e) => e.wt === wt.id && t - e.ts < HOT_MS)
      const on = state.wtFilter === wt.id
      return h(
        'button',
        {
          class: `chip${hot ? ' hot' : ''}${on ? ' on' : ''}`,
          title: `${wt.path}\n${on ? 'Click to show every worktree' : 'Click to show only this worktree'}`,
          'aria-pressed': on ? 'true' : 'false',
          onclick: () => {
            state.wtFilter = on ? null : wt.id
            state.pending = 0
            renderAll()
          },
        },
        wt.branch ?? 'detached',
        h('span', { class: 'sha' }, wt.head?.slice(0, 7) ?? ''),
      )
    }),
  )
}

function bar(added, deleted) {
  const total = added + deleted
  const w = magnitudeWidth(total)
  if (!w) return h('span', { class: 'bar' })
  const wa = Math.round((w * added) / total)
  return h(
    'span',
    { class: 'bar' },
    wa > 0 && h('i', { class: 'a', style: `width:${wa}px` }),
    w - wa > 0 && h('i', { class: 'd', style: `width:${w - wa}px` }),
  )
}

function pathNode(p) {
  const { dir, base } = splitPath(p)
  return [dir && h('span', { class: 'dir' }, dir), h('span', { class: 'base' }, base)]
}

function totals(added, deleted, binary = false) {
  return h(
    'span',
    { class: 'tot' },
    h('span', { class: 'a' }, binary ? 'bin' : `+${added}`),
    ' ',
    h('span', { class: 'd' }, `−${deleted}`),
  )
}

function highlightItems(subject) {
  const re = new RegExp(state.itemPattern, 'g')
  const out = []
  let last = 0
  for (const m of subject.matchAll(re)) {
    out.push(subject.slice(last, m.index), h('b', {}, m[0]))
    last = m.index + m[0].length
  }
  out.push(subject.slice(last))
  return out
}

const VERB = {
  created: 'new',
  modified: '',
  renamed: 'renamed',
  deleted: 'deleted',
  reverted: 'back to HEAD',
}

function rowClass(base, key, id) {
  return `${base}${state.selectedKey === key ? ' selected' : ''}${state.flashIds.has(id) ? ' flash' : ''}`
}

function timeCell(ts, prevTs) {
  const rep = prevTs !== null && Math.floor(ts / 1000) === Math.floor(prevTs / 1000)
  return h(
    'span',
    { class: `time${rep ? ' rep' : ''}`, title: new Date(ts).toLocaleString() },
    fmtTime(ts),
  )
}

function editRow(e, prevTs) {
  const key = `edit:${e.id}`
  const net = e.dAdded - e.dDeleted
  const verb = VERB[e.kind]
  const wt = wtLabel(e.wt)
  return h(
    'div',
    {
      class: rowClass(`row clickable k-${e.kind}`, key, e.id),
      dataset: { key },
      tabindex: '-1',
      onclick: () => openFile(e.wt, e.path, e, key),
      title: `${e.kind} · now +${e.added} −${e.deleted} vs HEAD${e.from ? ` · was ${e.from}` : ''}`,
    },
    timeCell(e.ts, prevTs),
    h('span', { class: 'glyph' }),
    h(
      'span',
      { class: 'what path' },
      pathNode(e.path),
      verb && h('span', { class: 'verb' }, verb),
      wt && h('span', { class: 'verb' }, `· ${wt}`),
    ),
    h(
      'span',
      { class: `net ${net > 0 ? 'pos' : net < 0 ? 'neg' : 'zero'}` },
      e.binary ? 'bin' : fmtSigned(net),
    ),
    e.kind === 'reverted' ? h('span', { class: 'tot' }) : totals(e.added, e.deleted, e.binary),
    bar(
      Math.max(0, e.dAdded) + Math.max(0, -e.dDeleted),
      Math.max(0, e.dDeleted) + Math.max(0, -e.dAdded),
    ),
  )
}

function commitRow(c, prevTs) {
  const key = `commit:${c.id}`
  const { commit } = c
  const wt = wtLabel(c.wt)
  return h(
    'div',
    {
      class: rowClass('row clickable k-commit', key, c.id),
      dataset: { key },
      tabindex: '-1',
      onclick: () => openCommit(c.wt, commit, key),
      title: `${commit.author} · ${new Date(commit.ts).toLocaleString()}`,
    },
    timeCell(c.ts, prevTs),
    h('span', { class: 'glyph' }),
    h(
      'span',
      { class: 'what' },
      h('span', { class: 'pill' }, commit.sha.slice(0, 7)),
      highlightItems(commit.subject),
      wt && h('span', { class: 'verb' }, `· ${wt}`),
    ),
    h('span', { class: 'net n' }, plural(commit.files.length, 'file')),
    totals(commit.added, commit.deleted),
    bar(commit.added, commit.deleted),
  )
}

function headRow(hd, prevTs) {
  const wt = wtLabel(hd.wt)
  return h(
    'div',
    { class: 'row k-head', dataset: { key: `head:${hd.id}` } },
    timeCell(hd.ts, prevTs),
    h('span', { class: 'glyph' }),
    h(
      'span',
      { class: 'what muted', style: 'grid-column: 3 / -1' },
      `HEAD moved to ${hd.to?.slice(0, 7) ?? 'nothing'}`,
      hd.branch && ` on ${hd.branch}`,
      wt && ` · ${wt}`,
      ' (reset, rebase, or checkout)',
    ),
  )
}

function scrolledDown() {
  return els.feed.scrollTop > SCROLLED_PX
}

function renderFeed() {
  const rows = feedRows()
  const sum = feedTotals(rows)
  els.feedCount.textContent = rows.length ? String(rows.length) : ''
  els.tabFeed.textContent = rows.length ? String(rows.length) : ''
  els.feedSum.replaceChildren(
    ...(sum.edits
      ? [
          h('span', { class: 'a' }, `+${sum.added}`),
          ' ',
          h('span', { class: 'd' }, `−${sum.deleted}`),
        ]
      : []),
  )
  if (!state.loaded) return
  if (!rows.length) {
    const why = state.filter
      ? 'Nothing matches that filter.'
      : state.wtFilter
        ? `Nothing on ${wtLabel(state.wtFilter) || 'that worktree'} in the last ${labelForWindow()}.`
        : `Nothing in the last ${labelForWindow()}.`
    els.feed.replaceChildren(
      h(
        'div',
        { class: 'empty' },
        why,
        h('div', { class: 'path' }, `Watching ${els.root.textContent}`),
      ),
    )
    hidePill()
    return
  }
  const frag = document.createDocumentFragment()
  let group = null
  let prevTs = null
  for (const r of rows.slice(0, FEED_LIMIT)) {
    const g = fmtGroup(r.ts)
    if (g !== group) {
      group = g
      prevTs = null
      frag.append(h('div', { class: 'group' }, g))
    }
    frag.append(
      r.type === 'edit'
        ? editRow(r, prevTs)
        : r.type === 'commit'
          ? commitRow(r, prevTs)
          : headRow(r, prevTs),
    )
    prevTs = r.ts
  }
  if (rows.length > FEED_LIMIT) {
    frag.append(
      h(
        'div',
        { class: 'more' },
        `Showing the latest ${FEED_LIMIT} of ${rows.length}. Narrow the window or filter to see the rest.`,
      ),
    )
  }
  // Emptying the list clamps scrollTop to 0 before the new rows land; put it back.
  const top = els.feed.scrollTop
  els.feed.replaceChildren(frag)
  els.feed.scrollTop = top
  state.flashIds.clear()
  hidePill()
}

function hidePill() {
  state.pending = 0
  els.newpill.hidden = true
  updateTitle()
}

function showPill() {
  els.newpill.textContent = `↑ ${plural(state.pending, 'new row')}`
  els.newpill.hidden = false
  updateTitle()
}

function updateTitle() {
  const name = state.repo?.name ?? 'repo-pulse'
  document.title = state.pending
    ? `(${state.pending}) ${name} · repo-pulse`
    : `${name} · repo-pulse`
}

/** Live rows land immediately unless the reader has scrolled into history; then they queue behind a pill. */
function onLiveRows(count) {
  if (count <= 0) return
  if (state.panel === 'feed' && scrolledDown() && !document.hidden) {
    state.pending += count
    showPill()
    return
  }
  invalidate('feed')
}

function labelForWindow() {
  const b = [...els.window.querySelectorAll('button')].find(
    (x) => Number(x.dataset.w) === state.window,
  )
  return b ? b.textContent : 'window'
}

function renderTree() {
  const t = now()
  const rows = []
  for (const sn of state.snapshots.values()) {
    if (!inWt(sn.wt.id)) continue
    for (const f of sn.files) {
      if (!matches(f.path)) continue
      rows.push({ wt: sn.wt.id, f, last: state.lastTouch.get(touchKey(sn.wt.id, f.path)) ?? 0 })
    }
  }
  els.treeCount.textContent = rows.length ? String(rows.length) : ''
  els.tabTree.textContent = rows.length ? String(rows.length) : ''
  if (!state.loaded) return
  if (!rows.length) {
    els.tree.replaceChildren(
      h(
        'div',
        { class: 'empty' },
        state.filter ? 'No changed file matches that filter.' : 'Working tree matches HEAD.',
      ),
    )
    return
  }
  // Directories are ordered by their busiest file, files by recency inside them, so each
  // directory heads exactly one contiguous group.
  const groupOf = (r) => {
    const top = r.f.path.includes('/') ? r.f.path.slice(0, r.f.path.indexOf('/')) + '/' : '·'
    const label = wtLabel(r.wt)
    return label ? `${label} ${top}` : top
  }
  const groupLast = new Map()
  for (const r of rows) {
    const g = groupOf(r)
    groupLast.set(g, Math.max(groupLast.get(g) ?? 0, r.last))
  }
  rows.sort((a, b) => {
    const ga = groupOf(a)
    const gb = groupOf(b)
    if (ga !== gb) return groupLast.get(gb) - groupLast.get(ga) || (ga < gb ? -1 : 1)
    return b.last - a.last || (a.f.path < b.f.path ? -1 : 1)
  })
  const frag = document.createDocumentFragment()
  let dir = null
  for (const r of rows.slice(0, TREE_LIMIT)) {
    const { wt, f, last } = r
    const top = f.path.includes('/') ? f.path.slice(0, f.path.indexOf('/')) + '/' : '·'
    const key = `tree:${wt}:${f.path}`
    const heat = last ? Math.max(0, 1 - (t - last) / HEAT_MS) : 0
    const groupKey = groupOf(r)
    if (groupKey !== dir) {
      dir = groupKey
      frag.append(h('div', { class: 'group' }, groupKey))
    }
    const kind =
      f.status === 'untracked' || f.status === 'added'
        ? 'created'
        : f.status === 'deleted'
          ? 'deleted'
          : f.status === 'renamed'
            ? 'renamed'
            : 'modified'
    frag.append(
      h(
        'div',
        {
          class: `row clickable k-${kind}${t - last < HOT_MS ? ' hot' : ''}${state.selectedKey === key ? ' selected' : ''}`,
          style: `--heat:${heat.toFixed(2)}`,
          dataset: { key },
          tabindex: '-1',
          onclick: () => openFile(wt, f.path, f, key),
          title: `${f.status}${f.from ? ` from ${f.from}` : ''}`,
        },
        h('span', { class: 'glyph' }),
        h('span', { class: 'what path' }, pathNode(f.path.slice(top === '·' ? 0 : top.length))),
        totals(f.added, f.deleted, f.binary),
        bar(f.added, f.deleted),
        h('span', { class: 'age', dataset: { ts: last || '' } }, last ? relativeTime(last, t) : ''),
      ),
    )
  }
  if (rows.length > TREE_LIMIT) {
    frag.append(
      h(
        'div',
        { class: 'more' },
        `${rows.length - TREE_LIMIT} more not shown. Filter to narrow the list.`,
      ),
    )
  }
  const treeTop = els.tree.scrollTop
  els.tree.replaceChildren(frag)
  els.tree.scrollTop = treeTop
}

function renderItems() {
  const t = now()
  const rows = rollupCommits(
    state.commits.filter((c) => inWt(c.wt)).map((c) => c.commit),
    state.itemPattern,
    since(),
  )
  els.itemsCount.textContent = rows.length ? String(rows.length) : ''
  els.tabItems.textContent = rows.length ? String(rows.length) : ''
  if (!state.loaded) return
  if (!rows.length) {
    els.items.replaceChildren(
      h('div', { class: 'empty' }, `No commits in the last ${labelForWindow()}.`),
    )
    return
  }
  const active = state.filter.trim()
  els.items.replaceChildren(
    ...rows.map((r) =>
      h(
        'div',
        {
          class: `row clickable${r.item !== 'unlabeled' && active === r.item ? ' on' : ''}`,
          tabindex: '-1',
          onclick: () => setFilter(r.item === 'unlabeled' || active === r.item ? '' : r.item),
          title: r.subjects.join('\n'),
        },
        h(
          'span',
          { class: `id${r.item === 'unlabeled' ? ' unlabeled' : ''}` },
          r.item === 'unlabeled' ? 'no id' : r.item,
        ),
        h(
          'span',
          { class: 'sub' },
          `${plural(r.commits, 'commit')} · ${plural(r.files, 'file')} · `,
          r.subjects[0] ?? '',
        ),
        totals(r.added, r.deleted),
        bar(r.added, r.deleted),
        h('span', { class: 'age', dataset: { ts: r.last } }, relativeTime(r.last, t)),
      ),
    ),
  )
}

function renderStatus() {
  const t = now()
  const parts = []
  if (!state.online) {
    els.status.className = 'status down'
    els.status.textContent = state.loaded ? 'connection lost · reconnecting…' : 'connecting…'
    return
  }
  els.status.className = 'status'
  parts.push('live')
  if (state.lastEventAt) {
    const ago = relativeTime(state.lastEventAt, t)
    parts.push(ago === 'now' ? 'last activity just now' : `last activity ${ago} ago`)
  }
  const n = state.worktrees.length
  if (n > 1) parts.push(plural(n, 'worktree'))
  parts.push(
    `${plural(state.edits.length, 'edit')}, ${plural(state.commits.length, 'commit')} loaded`,
  )
  els.status.textContent = parts.join(' · ')
}

function setFavicon(on) {
  const color = on ? '#3fb950' : '#8b9098'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5" fill="${color}"/></svg>`
  els.favicon.href = `data:image/svg+xml,${encodeURIComponent(svg)}`
}

function setOnline(on) {
  if (state.online === on) return
  state.online = on
  els.live.classList.toggle('on', on)
  setFavicon(on)
  invalidate('status')
}

function tickAges() {
  const t = now()
  for (const el of document.querySelectorAll('[data-ts]')) {
    const ts = Number(el.dataset.ts)
    if (ts) el.textContent = relativeTime(ts, t)
  }
  for (const el of document.querySelectorAll('.tree .row.hot')) {
    const ts = Number(el.querySelector('[data-ts]')?.dataset.ts)
    if (!ts || t - ts >= HOT_MS) el.classList.remove('hot')
  }
  renderStatus()
}

// --- drawer ------------------------------------------------------------------

function renderDiff(text) {
  const lines = numberDiff(text)
  const frag = document.createDocumentFragment()
  const files = []
  for (const line of lines) {
    const el = h(
      'span',
      { class: `l ${line.cls}` },
      line.cls === 'add' || line.cls === 'del' || line.cls === 'ctx'
        ? [
            h('span', { class: 'ln' }, line.old ?? ''),
            h('span', { class: 'ln' }, line.new ?? ''),
            h('span', { class: 'code' }, line.text || ' '),
          ]
        : h('span', { class: 'code' }, line.text || ' '),
    )
    if (line.cls === 'file') files.push({ path: line.path, el })
    frag.append(el)
  }
  els.diff.replaceChildren(frag)
  els.diff.scrollTop = 0
  els.drawerFiles.hidden = files.length < 2
  els.drawerFiles.replaceChildren(
    ...files.map(({ path, el }) =>
      h(
        'button',
        {
          onclick: () => {
            els.diff.scrollTop = el.offsetTop - els.diff.offsetTop
          },
        },
        splitPath(path).base,
      ),
    ),
  )
}

function showDrawer(title, statsNodes, drawer) {
  state.drawer = drawer
  els.drawerTitle.textContent = title
  els.drawerTitle.title = title
  els.drawerStats.replaceChildren(...statsNodes)
  els.cmuxBtn.hidden = !state.cmux
  els.drawerFiles.hidden = true
  els.diff.replaceChildren(h('div', { class: 'loading' }, 'Loading diff…'))
  els.drawer.hidden = false
  requestAnimationFrame(() => els.drawer.classList.add('open'))
}

function closeDrawer() {
  state.drawer = null
  els.drawer.classList.remove('open')
  els.drawer.hidden = true
  els.feed.focus({ preventScroll: true })
}

function select(key) {
  if (key === null) return
  state.selectedKey = key
  for (const el of document.querySelectorAll('.row.selected')) el.classList.remove('selected')
  for (const el of document.querySelectorAll(`[data-key="${CSS.escape(key)}"]`))
    el.classList.add('selected')
}

async function openFile(wt, path, stat, key = null) {
  select(key)
  const label = wtLabel(wt)
  showDrawer(
    path,
    [
      h('span', { class: 'a' }, `+${stat.added}`),
      ' ',
      h('span', { class: 'd' }, `−${stat.deleted}`),
      ` · ${stat.status ?? stat.kind} vs HEAD`,
      label && ` · ${label}`,
    ],
    { kind: 'file', wt, path },
  )
  try {
    const res = await fetch(
      `/api/diff?wt=${encodeURIComponent(wt)}&path=${encodeURIComponent(path)}`,
    )
    const text = await res.text()
    if (state.drawer?.path !== path) return
    if (res.ok) renderDiff(text)
    else
      els.diff.replaceChildren(
        h('div', { class: 'err' }, text || 'This file no longer differs from HEAD.'),
      )
  } catch (err) {
    if (state.drawer?.path === path)
      els.diff.replaceChildren(
        h('div', { class: 'err' }, `Could not load the diff: ${err.message}`),
      )
  }
}

async function openCommit(wt, commit, key = null) {
  select(key)
  showDrawer(
    `${commit.sha.slice(0, 7)}  ${commit.subject}`,
    [
      `${plural(commit.files.length, 'file')} · `,
      h('span', { class: 'a' }, `+${commit.added}`),
      ' ',
      h('span', { class: 'd' }, `−${commit.deleted}`),
      ` · ${commit.author}`,
    ],
    { kind: 'commit', wt, sha: commit.sha },
  )
  try {
    const res = await fetch(`/api/commit?wt=${encodeURIComponent(wt)}&sha=${commit.sha}`)
    const text = await res.text()
    if (state.drawer?.sha !== commit.sha) return
    if (res.ok) renderDiff(text)
    else els.diff.replaceChildren(h('div', { class: 'err' }, text))
  } catch (err) {
    if (state.drawer?.sha === commit.sha)
      els.diff.replaceChildren(
        h('div', { class: 'err' }, `Could not load the patch: ${err.message}`),
      )
  }
}

async function openInCmux() {
  const d = state.drawer
  if (!d) return
  const q =
    d.kind === 'commit'
      ? `wt=${encodeURIComponent(d.wt)}&sha=${d.sha}`
      : `wt=${encodeURIComponent(d.wt)}&path=${encodeURIComponent(d.path)}`
  els.cmuxBtn.disabled = true
  try {
    const r = await fetch(`/api/cmux-diff?${q}`, { method: 'POST' }).then((x) => x.json())
    els.cmuxBtn.textContent = r.ok ? 'Opened' : 'Failed'
    if (!r.ok) els.cmuxBtn.title = r.reason ?? ''
  } catch {
    els.cmuxBtn.textContent = 'Failed'
  } finally {
    setTimeout(() => {
      els.cmuxBtn.textContent = 'Open in cmux'
      els.cmuxBtn.title = ''
      els.cmuxBtn.disabled = false
    }, 1200)
  }
}

// --- keyboard ----------------------------------------------------------------

function activeList() {
  return state.panel === 'tree' ? els.tree : state.panel === 'items' ? els.items : els.feed
}

function moveSelection(delta) {
  const list = activeList()
  const rows = [...list.querySelectorAll('.row.clickable')]
  if (!rows.length) return
  const i = rows.findIndex((r) => r.dataset.key === state.selectedKey)
  const start = i < 0 ? (delta > 0 ? -1 : rows.length) : i
  const next = rows[Math.min(rows.length - 1, Math.max(0, start + delta))]
  rows[i]?.classList.remove('selected')
  next.classList.add('selected')
  state.selectedKey = next.dataset.key
  next.scrollIntoView({ block: 'nearest' })
}

document.addEventListener('keydown', (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return
  if (ev.target === els.filter) {
    if (ev.key === 'Escape') {
      setFilter('')
      els.filter.blur()
    } else if (ev.key === 'Enter') els.filter.blur()
    return
  }
  if (ev.key === 'Escape') {
    if (state.drawer) return closeDrawer()
    if (state.filter) return setFilter('')
    if (state.wtFilter) {
      state.wtFilter = null
      return renderAll()
    }
    return
  }
  if (ev.key === 'j' || ev.key === 'ArrowDown') {
    ev.preventDefault()
    moveSelection(1)
  } else if (ev.key === 'k' || ev.key === 'ArrowUp') {
    ev.preventDefault()
    moveSelection(-1)
  } else if (ev.key === 'Enter' && state.selectedKey) {
    activeList()
      .querySelector(`[data-key="${CSS.escape(state.selectedKey)}"]`)
      ?.click()
  } else if (ev.key === '/') {
    ev.preventDefault()
    els.filter.focus()
    els.filter.select()
  } else if (ev.key === 'g') {
    els.feed.scrollTo({ top: 0 })
    if (state.pending) invalidate('feed')
  } else if (ev.key >= '1' && ev.key <= '5') {
    els.window.querySelectorAll('button')[Number(ev.key) - 1]?.click()
  }
})

// --- wiring ------------------------------------------------------------------

function setFilter(value) {
  els.filter.value = value
  state.filter = value
  state.pending = 0
  renderAll()
}

els.window.addEventListener('click', (ev) => {
  const b = ev.target.closest('button')
  if (!b) return
  for (const x of els.window.querySelectorAll('button')) x.classList.toggle('on', x === b)
  state.window = Number(b.dataset.w)
  state.pending = 0
  try {
    localStorage.setItem('repo-pulse.window', String(state.window))
  } catch {}
  renderAll()
})
els.filter.addEventListener('input', () => setFilter(els.filter.value))
els.tabs.addEventListener('click', (ev) => {
  const b = ev.target.closest('button')
  if (!b) return
  setPanel(b.dataset.panel)
})
els.newpill.addEventListener('click', () => {
  els.feed.scrollTo({ top: 0 })
  invalidate('feed')
})
els.feed.addEventListener('scroll', () => {
  if (state.pending && !scrolledDown()) invalidate('feed')
})
els.drawerClose.addEventListener('click', closeDrawer)
els.cmuxBtn.addEventListener('click', openInCmux)
els.theme.addEventListener('click', () => {
  const i = THEMES.indexOf(document.documentElement.dataset.theme ?? 'auto')
  setTheme(THEMES[(i + 1) % THEMES.length])
})
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.pending) invalidate('feed')
})

function setPanel(panel) {
  state.panel = panel
  for (const b of els.tabs.querySelectorAll('button'))
    b.classList.toggle('on', b.dataset.panel === panel)
  for (const id of ['feed', 'tree', 'items']) $(`panel-${id}`).classList.toggle('on', id === panel)
  if (panel === 'feed' && state.pending) invalidate('feed')
}

function setTheme(theme) {
  if (theme === 'auto') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = theme
  els.theme.textContent = theme
  els.theme.title = `Theme: ${theme} (click to change)`
  try {
    localStorage.setItem('repo-pulse.theme', theme)
  } catch {}
}

async function loadState() {
  const s = await fetch('/api/state').then((r) => r.json())
  replaceState(s)
  renderAll()
}

function connect() {
  const es = new EventSource('/events')
  let wasDown = false
  es.onopen = () => {
    setOnline(true)
    if (wasDown) loadState().catch(console.error)
    wasDown = false
  }
  es.onerror = () => {
    setOnline(false)
    wasDown = true
  }
  const live = (type) =>
    es.addEventListener(type, (m) => {
      const ev = JSON.parse(m.data)
      if (!ingest(ev, { live: true })) return
      const visible = feedRows().some((r) => r.id === ev.id)
      onLiveRows(visible ? 1 : 0)
      invalidate('header', 'status', type === 'commit' ? 'items' : 'tree')
    })
  live('edit')
  live('commit')
  live('head')
  es.addEventListener('snapshot', (m) => {
    const sn = JSON.parse(m.data)
    state.snapshots.set(sn.wt.id, sn)
    const i = state.worktrees.findIndex((w) => w.id === sn.wt.id)
    if (i >= 0) state.worktrees[i] = sn.wt
    invalidate('header', 'tree')
  })
  es.addEventListener('worktrees', (m) => {
    state.worktrees = JSON.parse(m.data)
    for (const id of [...state.snapshots.keys()])
      if (!state.worktrees.some((w) => w.id === id)) state.snapshots.delete(id)
    if (state.wtFilter && !state.worktrees.some((w) => w.id === state.wtFilter))
      state.wtFilter = null
    renderAll()
  })
}

function skeleton() {
  els.feed.replaceChildren(
    h(
      'div',
      { class: 'skeleton' },
      ...Array.from({ length: 8 }, () =>
        h(
          'div',
          { class: 'row' },
          h('span', { class: 'sk', style: 'width:40px' }),
          h('span'),
          h('span', { class: 'sk', style: 'width:60%' }),
          h('span'),
          h('span'),
          h('span'),
        ),
      ),
    ),
  )
}

try {
  const w = localStorage.getItem('repo-pulse.window')
  if (w !== null && [...els.window.querySelectorAll('button')].some((b) => b.dataset.w === w)) {
    state.window = Number(w)
    for (const b of els.window.querySelectorAll('button'))
      b.classList.toggle('on', b.dataset.w === w)
  }
  const theme = localStorage.getItem('repo-pulse.theme')
  setTheme(THEMES.includes(theme) ? theme : 'auto')
} catch {
  setTheme('auto')
}

setFavicon(false)
skeleton()
loadState()
  .then(connect)
  .catch((err) => {
    console.error(err)
    els.feed.replaceChildren(
      h('div', { class: 'empty' }, 'Could not reach repo-pulse. Is the server running?'),
    )
    els.status.className = 'status down'
    els.status.textContent = 'server unreachable'
  })
setInterval(tickAges, 5000)
