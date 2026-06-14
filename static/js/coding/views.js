// static/js/coding/views.js — Views side panel: Diff / Terminal / Files / Plan.
// Each panel is wired to a real Odysseus backend — no empty shells.
import { renderDiff } from './diff.js';

let _current = '';
let _stateRef = null;

const TITLES = { diff: 'Diff', terminal: 'Terminal', files: 'Files', plan: 'Plan' };

export function initViews(state) {
  _stateRef = state;
  document.getElementById('coding-views-close')?.addEventListener('click', () => {
    document.getElementById('coding-views-panel')?.classList.add('hidden');
    _current = '';
  });
  document.getElementById('coding-views-refresh')?.addEventListener('click', () => {
    if (_current) _load(_current, _stateRef, true);
  });
}

export function openView(view, state) {
  const panel = document.getElementById('coding-views-panel');
  if (!panel) return;
  if (_current === view && !panel.classList.contains('hidden')) {
    panel.classList.add('hidden'); _current = ''; return;     // toggle off
  }
  panel.classList.remove('hidden');
  _current = view;
  document.getElementById('coding-views-title').textContent = TITLES[view] || view;
  _load(view, state);
}

async function _load(view, state) {
  const content = document.getElementById('coding-views-content');
  if (!content) return;
  content.innerHTML = '<div class="coding-menu-empty">Loading…</div>';

  if (view === 'diff')     return _loadDiff(content, state);
  if (view === 'terminal') return _loadTerminal(content, state);
  if (view === 'files')    return _loadFiles(content, state);
  if (view === 'plan')     return _loadPlan(content, state);
}

/* ── Diff: full workspace git diff ── */
async function _loadDiff(content, state) {
  try {
    const r = await fetch(`/api/coding/sessions/${state.activeSessionId}/git/diff`);
    const { diff } = await r.json();
    content.innerHTML = '';
    if (!diff.trim()) {
      content.innerHTML = '<div class="coding-menu-empty">Working tree clean — no changes</div>';
      return;
    }
    // Split per file so each gets its own header.
    const parts = diff.split(/^diff --git /m).filter(Boolean);
    for (const part of parts) {
      const text  = part.startsWith('a/') ? 'diff --git ' + part : part;
      const match = part.match(/b\/([^\s\n]+)/);
      renderDiff(content, { text, file: match ? match[1] : '' });
    }
  } catch {
    content.innerHTML = '<div class="coding-menu-empty">Could not load diff</div>';
  }
}

/* ── Terminal: streaming shell via existing /api/shell/stream ── */
function _loadTerminal(content) {
  content.innerHTML = `
    <div class="coding-term">
      <div id="coding-term-out" class="coding-term-out"></div>
      <div class="coding-term-inrow">
        <span class="coding-term-prompt">&gt;</span>
        <input id="coding-term-in" class="coding-term-in" placeholder="Run a command…"
          spellcheck="false" autocomplete="off">
      </div>
    </div>`;
  const out = content.querySelector('#coding-term-out');
  const inp = content.querySelector('#coding-term-in');
  inp.focus();
  inp.addEventListener('keydown', async (e) => {
    e.stopPropagation();
    if (e.key !== 'Enter') return;
    const cmd = inp.value.trim();
    if (!cmd) return;
    inp.value = '';
    _termLine(out, `> ${cmd}`, 'cmd');
    try {
      const r = await fetch('/api/shell/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd }),
      });
      if (!r.ok || !r.body) { _termLine(out, `HTTP ${r.status}`, 'err'); return; }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          let evt; try { evt = JSON.parse(line.slice(6)); } catch { continue; }
          if (evt.data) _termLine(out, evt.data, evt.stream === 'stderr' ? 'err' : '');
          if (evt.exit_code !== undefined) _termLine(out, `· exit ${evt.exit_code}`, 'meta');
        }
      }
    } catch (err) {
      _termLine(out, String(err.message || err), 'err');
    }
  });
}

function _termLine(out, text, cls) {
  const el = document.createElement('div');
  el.className = `coding-term-line ${cls || ''}`;
  el.textContent = text;
  out.appendChild(el);
  out.scrollTop = out.scrollHeight;
}

/* ── Files: workspace tree ── */
async function _loadFiles(content, state) {
  try {
    const r = await fetch(`/api/coding/sessions/${state.activeSessionId}/files`);
    const { tree, root } = await r.json();
    content.innerHTML = '';
    if (!tree?.length) {
      content.innerHTML = '<div class="coding-menu-empty">No workspace files</div>';
      return;
    }
    const rootEl = document.createElement('div');
    rootEl.className = 'coding-files-root';
    rootEl.textContent = root || '';
    content.appendChild(rootEl);
    content.appendChild(_renderTree(tree));
  } catch {
    content.innerHTML = '<div class="coding-menu-empty">Could not load files</div>';
  }
}

function _renderTree(nodes) {
  const ul = document.createElement('div');
  ul.className = 'coding-files-list';
  for (const n of nodes) {
    const row = document.createElement('div');
    row.className = `coding-files-item ${n.type}`;
    row.innerHTML = n.type === 'dir'
      ? `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg><span>${_esc(n.name)}</span>`
      : `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/></svg><span>${_esc(n.name)}</span>`;
    ul.appendChild(row);
    if (n.type === 'dir' && n.children?.length) {
      const kids = _renderTree(n.children);
      kids.classList.add('hidden', 'coding-files-children');
      ul.appendChild(kids);
      row.addEventListener('click', () => kids.classList.toggle('hidden'));
    }
  }
  return ul;
}

/* ── Plan: session todos ── */
async function _loadPlan(content, state) {
  try {
    const r = await fetch(`/api/coding/sessions/${state.activeSessionId}`);
    const session = await r.json();
    const todos = session.todo || [];
    if (!todos.length) {
      content.innerHTML = '<div class="coding-menu-empty">No plan yet — the agent builds one when you give it a multi-step task</div>';
      return;
    }
    content.innerHTML = `<div class="coding-plan-list">${todos.map(t => {
      const status = t.status || 'pending';
      const icon = status === 'done' ? '✓' : status === 'in_progress' ? '◐' : '○';
      return `<div class="coding-plan-item ${status}">
        <span class="coding-plan-icon">${icon}</span>
        <span>${_esc(t.text || t.content || '')}</span>
      </div>`;
    }).join('')}</div>`;
  } catch {
    content.innerHTML = '<div class="coding-menu-empty">Could not load plan</div>';
  }
}

function _esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
