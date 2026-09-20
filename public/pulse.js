import { magnitudeWidth, mergeFeed, relativeTime, rollupCommits, splitPath } from './lib.js'

const HOT_MS = 60_000
const HEAT_MS = 15 * 60_000
const FEED_LIMIT = 400
const GROUP_MS = 5 * 60_000

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
  selectedKey: null,
  drawer: null, // { kind: 'file'|'commit', wt, path?, sha?, stats }
  skew: 0,
  loaded: false,
}

const $ = (id) => document.getElementById(id)
const els = {
  live: $('live'),
  repo: $('repo'),
  root: $('root'),
  wts: $('wts'),
  window: $('window'),
  filter: $('filter'),
  feed: $('feed'),
  feedCount: $('feed-count'),
  tree: $('tree'),
  treeCount: $('tree-count'),
  items: $('items'),
  itemsCount: $('items-count'),
  drawer: $('drawer'),
  drawerTitle: $('drawer-title'),
  drawerStats: $('drawer-stats'),
  cmuxBtn: $('cmux-btn'),
  drawerClose: $('drawer-close'),
  diff: $('diff'),
}

const now = () => Date.now() + state.skew
const since = () => (state.window ? now() - state.window : 0)
const touchKey = (wt, path) => `${wt}\0${path}`
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

function ingest(ev, { flash = false } = {}) {
  if (state.seen.has(ev.id)) return
  state.seen.add(ev.id)
  if (ev.type === 'edit') {
    state.edits.push(ev)
    state.lastTouch.set(touchKey(ev.wt, ev.path), ev.ts)
  } else if (ev.type === 'commit') state.commits.push(ev)
  else state.heads.push(ev)
  if (flash) state.flashId = ev.id
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
  state.loaded = true
}

function matches(text) {
  const q = state.filter.trim().toLowerCase()
  return !q || text.toLowerCase().includes(q)
}

function wtLabel(wtId) {
  if (state.worktrees.length < 2) return ''
  const wt = state.worktrees.find((w) => w.id === wtId)
  return wt ? (wt.branch ?? wt.head?.slice(0, 7) ?? '?') : '?'
}

// --- rendering ---------------------------------------------------------------

function renderHeader() {
  if (!state.repo) return
  els.repo.textContent = state.repo.name
  els.root.textContent = state.repo.root.replace(/^\/Users\/[^/]+/, '~')
  document.title = `${state.repo.name} · repo-pulse`
  const t = now()
  els.wts.replaceChildren(
    ...state.worktrees.map((wt) => {
      const hot = state.edits.some((e) => e.wt === wt.id && t - e.ts < HOT_MS)
      return h(
        'span',
        { class: `chip${hot ? ' hot' : ''}`, title: wt.path },
        wt.branch ?? 'detached',
        h('span', { class: 'sha' }, wt.head?.slice(0, 7) ?? ''),
      )
    }),
  )
}

function bar(added, deleted, cls = null) {
  const total = added + deleted
  const w = magnitudeWidth(total)
  if (!w) return h('span', { class: 'bar' })
  if (cls) return h('span', { class: 'bar' }, h('i', { class: cls, style: `width:${w}px` }))
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

function editRow(e) {
  const key = `edit:${e.id}`
  const net = e.dAdded - e.dDeleted
  const magnitude = Math.abs(e.dAdded) + Math.abs(e.dDeleted)
  const verb = VERB[e.kind]
  const wt = wtLabel(e.wt)
  return h(
    'div',
    {
      class: `row clickable k-${e.kind}${state.selectedKey === key ? ' selected' : ''}${state.flashId === e.id ? ' flash' : ''}`,
      dataset: { key },
      tabindex: '-1',
      onclick: () => openFile(e.wt, e.path, e),
      title: `${e.kind} · now +${e.added} −${e.deleted} vs HEAD${e.from ? ` · was ${e.from}` : ''}`,
    },
    h('span', { class: 'time' }, fmtTime(e.ts)),
    h('span', { class: 'glyph' }),
    h(
      'span',
      { class: 'what' },
      pathNode(e.path),
      verb && h('span', { class: 'verb' }, verb),
      wt && h('span', { class: 'verb' }, `· ${wt}`),
    ),
    h(
      'span',
      { class: 'delta' },
      h(
        'span',
        { class: `net ${net > 0 ? 'pos' : net < 0 ? 'neg' : 'zero'}` },
        e.binary ? 'bin' : fmtSigned(net),
      ),
      e.kind !== 'reverted' &&
        h(
          'span',
          { class: 'tot' },
          h('span', { class: 'a' }, `+${e.added}`),
          ' ',
          h('span', { class: 'd' }, `−${e.deleted}`),
        ),
    ),
    bar(
      Math.max(0, e.dAdded) + Math.max(0, -e.dDeleted),
      Math.max(0, e.dDeleted) + Math.max(0, -e.dAdded),
    ) || bar(magnitude, 0),
  )
}

function commitRow(c) {
  const key = `commit:${c.id}`
  const { commit } = c
  const wt = wtLabel(c.wt)
  return h(
    'div',
    {
      class: `row clickable k-commit${state.selectedKey === key ? ' selected' : ''}${state.flashId === c.id ? ' flash' : ''}`,
      dataset: { key },
      tabindex: '-1',
      onclick: () => openCommit(c.wt, commit),
      title: `${commit.author} · ${new Date(commit.ts).toLocaleString()}`,
    },
    h('span', { class: 'time' }, fmtTime(c.ts)),
    h('span', { class: 'glyph' }),
    h(
      'span',
      { class: 'what' },
      h('span', { class: 'pill' }, commit.sha.slice(0, 7)),
      highlightItems(commit.subject),
      wt && h('span', { class: 'verb' }, `· ${wt}`),
    ),
    h(
      'span',
      { class: 'delta' },
      h(
        'span',
        { class: 'tot' },
        `${commit.files.length} file${commit.files.length === 1 ? '' : 's'} `,
        h('span', { class: 'a' }, `+${commit.added}`),
        ' ',
        h('span', { class: 'd' }, `−${commit.deleted}`),
      ),
    ),
    bar(commit.added, commit.deleted),
  )
}

function headRow(hd) {
  const wt = wtLabel(hd.wt)
  return h(
    'div',
    { class: 'row k-head', dataset: { key: `head:${hd.id}` } },
    h('span', { class: 'time' }, fmtTime(hd.ts)),
    h('span', { class: 'glyph' }),
    h(
      'span',
      { class: 'what muted' },
      `HEAD moved to ${hd.to?.slice(0, 7) ?? 'nothing'}`,
      hd.branch && ` on ${hd.branch}`,
      wt && ` · ${wt}`,
      ' (reset, rebase, or checkout)',
    ),
    h('span'),
    h('span'),
  )
}

function renderFeed() {
  const rows = mergeFeed(state.edits, state.commits, state.heads, since()).filter((r) =>
    r.type === 'edit'
      ? matches(r.path)
      : r.type === 'commit'
        ? matches(`${r.commit.subject} ${r.commit.sha}`)
        : true,
  )
  els.feedCount.textContent = rows.length ? String(rows.length) : ''
  if (!state.loaded) return
  if (!rows.length) {
    els.feed.replaceChildren(
      h(
        'div',
        { class: 'empty' },
        state.filter ? 'Nothing matches that filter.' : `Nothing in the last ${labelForWindow()}.`,
        h('div', { class: 'path' }, `Watching ${els.root.textContent}`),
      ),
    )
    return
  }
  const frag = document.createDocumentFragment()
  let group = null
  for (const r of rows.slice(0, FEED_LIMIT)) {
    const g = fmtGroup(r.ts)
    if (g !== group) {
      group = g
      frag.append(h('div', { class: 'group' }, g))
    }
    frag.append(r.type === 'edit' ? editRow(r) : r.type === 'commit' ? commitRow(r) : headRow(r))
  }
  els.feed.replaceChildren(frag)
  state.flashId = null
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
    for (const f of sn.files) {
      if (!matches(f.path)) continue
      rows.push({ wt: sn.wt.id, f, last: state.lastTouch.get(touchKey(sn.wt.id, f.path)) ?? 0 })
    }
  }
  els.treeCount.textContent = rows.length ? String(rows.length) : ''
  if (!state.loaded) return
  if (!rows.length) {
    els.tree.replaceChildren(h('div', { class: 'empty' }, 'Working tree matches HEAD.'))
    return
  }
  rows.sort((a, b) => b.last - a.last || (a.f.path < b.f.path ? -1 : 1))
  const frag = document.createDocumentFragment()
  let dir = null
  for (const { wt, f, last } of rows) {
    const top = f.path.includes('/') ? f.path.slice(0, f.path.indexOf('/')) + '/' : '·'
    const key = `tree:${wt}:${f.path}`
    const heat = last ? Math.max(0, 1 - (t - last) / HEAT_MS) : 0
    const label = wtLabel(wt)
    const groupKey = label ? `${label} ${top}` : top
    if (groupKey !== dir) {
      dir = groupKey
      frag.append(h('div', { class: 'group' }, groupKey))
    }
    frag.append(
      h(
        'div',
        {
          class: `row clickable k-${f.status === 'untracked' || f.status === 'added' ? 'created' : f.status === 'deleted' ? 'deleted' : f.status === 'renamed' ? 'renamed' : 'modified'}${t - last < HOT_MS ? ' hot' : ''}${state.selectedKey === key ? ' selected' : ''}`,
          style: `--heat:${heat.toFixed(2)}`,
          dataset: { key },
          onclick: () => openFile(wt, f.path, f, key),
          title: `${f.status}${f.from ? ` from ${f.from}` : ''}`,
        },
        h('span', { class: 'glyph' }),
        h('span', { class: 'what' }, pathNode(f.path.slice(top === '·' ? 0 : top.length))),
        h(
          'span',
          { class: 'delta' },
          h(
            'span',
            { class: 'tot' },
            h('span', { class: 'a' }, f.binary ? 'bin' : `+${f.added}`),
            ' ',
            h('span', { class: 'd' }, `−${f.deleted}`),
          ),
        ),
        bar(f.added, f.deleted),
        h('span', { class: 'age', dataset: { ts: last || '' } }, last ? relativeTime(last, t) : ''),
      ),
    )
  }
  els.tree.replaceChildren(frag)
}

function renderItems() {
  const t = now()
  const rows = rollupCommits(
    state.commits.map((c) => c.commit),
    state.itemPattern,
    since(),
  )
  els.itemsCount.textContent = rows.length ? String(rows.length) : ''
  if (!state.loaded) return
  if (!rows.length) {
    els.items.replaceChildren(
      h('div', { class: 'empty' }, `No commits in the last ${labelForWindow()}.`),
    )
    return
  }
  els.items.replaceChildren(
    ...rows.map((r) =>
      h(
        'div',
        {
          class: 'row clickable',
          onclick: () => {
            els.filter.value = r.item === 'unlabeled' ? '' : r.item
            state.filter = els.filter.value
            renderAll()
          },
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
          `${r.commits} commit${r.commits === 1 ? '' : 's'} · ${r.files} file${r.files === 1 ? '' : 's'} · `,
          r.subjects[0] ?? '',
        ),
        h(
          'span',
          { class: 'delta' },
          h(
            'span',
            { class: 'tot' },
            h('span', { class: 'a' }, `+${r.added}`),
            ' ',
            h('span', { class: 'd' }, `−${r.deleted}`),
          ),
        ),
        bar(r.added, r.deleted),
        h('span', { class: 'age', dataset: { ts: r.last } }, relativeTime(r.last, t)),
      ),
    ),
  )
}

function renderAll() {
  renderHeader()
  renderFeed()
  renderTree()
  renderItems()
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
}

// --- drawer ------------------------------------------------------------------

function renderDiff(text) {
  const frag = document.createDocumentFragment()
  for (const line of text.split('\n')) {
    let cls = 'ctx'
    if (line.startsWith('diff --git')) cls = 'file'
    else if (
      line.startsWith('+++') ||
      line.startsWith('---') ||
      line.startsWith('index ') ||
      line.startsWith('new file') ||
      line.startsWith('deleted file') ||
      line.startsWith('similarity') ||
      line.startsWith('rename ')
    )
      cls = 'meta'
    else if (line.startsWith('@@')) cls = 'hunk'
    else if (line.startsWith('+')) cls = 'add'
    else if (line.startsWith('-')) cls = 'del'
    frag.append(h('span', { class: `l ${cls}` }, line || ' '))
  }
  els.diff.replaceChildren(frag)
  els.diff.scrollTop = 0
}

function showDrawer(title, statsNodes, drawer) {
  state.drawer = drawer
  els.drawerTitle.textContent = title
  els.drawerStats.replaceChildren(...statsNodes)
  els.cmuxBtn.hidden = !state.cmux
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

async function openFile(wt, path, stat, key = null) {
  state.selectedKey = key ?? state.selectedKey
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
  const res = await fetch(`/api/diff?wt=${encodeURIComponent(wt)}&path=${encodeURIComponent(path)}`)
  const text = await res.text()
  if (state.drawer?.path !== path) return
  renderDiff(res.ok ? text : text || 'This file no longer differs from HEAD.')
}

async function openCommit(wt, commit) {
  showDrawer(
    `${commit.sha.slice(0, 7)}  ${commit.subject}`,
    [
      `${commit.files.length} files · `,
      h('span', { class: 'a' }, `+${commit.added}`),
      ' ',
      h('span', { class: 'd' }, `−${commit.deleted}`),
      ` · ${commit.author}`,
    ],
    { kind: 'commit', wt, sha: commit.sha },
  )
  const res = await fetch(`/api/commit?wt=${encodeURIComponent(wt)}&sha=${commit.sha}`)
  const text = await res.text()
  if (state.drawer?.sha !== commit.sha) return
  renderDiff(text)
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
  } finally {
    setTimeout(() => {
      els.cmuxBtn.textContent = 'Open in cmux'
      els.cmuxBtn.disabled = false
    }, 1200)
  }
}

// --- keyboard ----------------------------------------------------------------

function moveSelection(delta) {
  const rows = [...els.feed.querySelectorAll('.row.clickable')]
  if (!rows.length) return
  const i = rows.findIndex((r) => r.dataset.key === state.selectedKey)
  const next =
    rows[
      Math.min(rows.length - 1, Math.max(0, (i < 0 ? (delta > 0 ? -1 : rows.length) : i) + delta))
    ]
  rows[i]?.classList.remove('selected')
  next.classList.add('selected')
  state.selectedKey = next.dataset.key
  next.scrollIntoView({ block: 'nearest' })
}

document.addEventListener('keydown', (ev) => {
  if (ev.target === els.filter) {
    if (ev.key === 'Escape') {
      els.filter.value = ''
      state.filter = ''
      els.filter.blur()
      renderAll()
    }
    return
  }
  if (ev.key === 'Escape' && state.drawer) return closeDrawer()
  if (ev.key === 'j' || ev.key === 'ArrowDown') {
    ev.preventDefault()
    moveSelection(1)
  } else if (ev.key === 'k' || ev.key === 'ArrowUp') {
    ev.preventDefault()
    moveSelection(-1)
  } else if (ev.key === 'Enter' && state.selectedKey)
    els.feed.querySelector(`[data-key="${CSS.escape(state.selectedKey)}"]`)?.click()
  else if (ev.key === '/') {
    ev.preventDefault()
    els.filter.focus()
  }
})

// --- wiring ------------------------------------------------------------------

els.window.addEventListener('click', (ev) => {
  const b = ev.target.closest('button')
  if (!b) return
  for (const x of els.window.querySelectorAll('button')) x.classList.toggle('on', x === b)
  state.window = Number(b.dataset.w)
  try {
    localStorage.setItem('repo-pulse.window', String(state.window))
  } catch {}
  renderAll()
})
els.filter.addEventListener('input', () => {
  state.filter = els.filter.value
  renderAll()
})
els.drawerClose.addEventListener('click', closeDrawer)
els.cmuxBtn.addEventListener('click', openInCmux)

async function loadState() {
  const s = await fetch('/api/state').then((r) => r.json())
  replaceState(s)
  renderAll()
}

function connect() {
  const es = new EventSource('/events')
  let wasDown = false
  es.onopen = () => {
    els.live.classList.add('on')
    if (wasDown) loadState().catch(console.error)
    wasDown = false
  }
  es.onerror = () => {
    els.live.classList.remove('on')
    wasDown = true
  }
  const live = (type) =>
    es.addEventListener(type, (m) => {
      ingest(JSON.parse(m.data), { flash: true })
      renderAll()
    })
  live('edit')
  live('commit')
  live('head')
  es.addEventListener('snapshot', (m) => {
    const sn = JSON.parse(m.data)
    state.snapshots.set(sn.wt.id, sn)
    const i = state.worktrees.findIndex((w) => w.id === sn.wt.id)
    if (i >= 0) state.worktrees[i] = sn.wt
    renderHeader()
    renderTree()
  })
  es.addEventListener('worktrees', (m) => {
    state.worktrees = JSON.parse(m.data)
    for (const id of [...state.snapshots.keys()])
      if (!state.worktrees.some((w) => w.id === id)) state.snapshots.delete(id)
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
} catch {}

skeleton()
loadState()
  .then(connect)
  .catch((err) => {
    console.error(err)
    els.feed.replaceChildren(
      h('div', { class: 'empty' }, 'Could not reach repo-pulse. Is the server running?'),
    )
  })
setInterval(tickAges, 5000)
