// static/js/coding/session.js — sessions live in the top-bar title dropdown
import { renderHistory, seedContextWheel } from './stream.js';

export function initSessionList(state) {
  const titleBtn = document.getElementById('coding-title-btn');
  const menu     = document.getElementById('coding-session-menu');
  titleBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.classList.contains('hidden')) _renderMenu(state);
    menu.classList.toggle('hidden');
  });
}

export async function loadSessions(state) {
  try {
    const r = await fetch('/api/coding/sessions');
    if (!r.ok) return;
    const sessions = await r.json();
    state._sessions = sessions;
    if (!state.activeSessionId && sessions.length > 0) {
      await selectSession(sessions[0].id, state);
    } else if (sessions.length === 0) {
      await createSession(state);
    }
  } catch (err) {
    console.warn('[coding] loadSessions failed:', err);
  }
}

function _renderMenu(state) {
  const menu = document.getElementById('coding-session-menu');
  if (!menu) return;
  const sessions = state._sessions || [];
  menu.innerHTML = `
    ${sessions.map(s => `
      <div class="coding-menu-item coding-session-row${s.id === state.activeSessionId ? ' selected' : ''}"
        data-session-id="${s.id}">
        <span class="coding-session-row-name">${_esc(s.name)}</span>
        <button class="coding-session-rename" data-rename="${s.id}" title="Rename">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>
        </button>
        <button class="coding-session-delete" data-delete="${s.id}" title="Delete">&#x2715;</button>
      </div>`).join('')}
    <div class="coding-menu-divider"></div>
    <div class="coding-menu-item" data-new-session>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      <span>New session</span>
    </div>
    <div class="coding-menu-divider"></div>
    <div class="coding-menu-item" data-connect="path">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
      <span>Connect local folder…</span>
    </div>
    <div class="coding-menu-item" data-connect="github">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/></svg>
      <span>Clone from GitHub…</span>
    </div>`;

  menu.querySelectorAll('.coding-session-row').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-rename]') || e.target.closest('[data-delete]')) return;
      menu.classList.add('hidden');
      selectSession(el.dataset.sessionId, state);
    });
  });
  menu.querySelectorAll('[data-rename]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      _inlineRename(btn.dataset.rename, state);
    });
  });
  menu.querySelectorAll('[data-delete]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await fetch(`/api/coding/sessions/${btn.dataset.delete}`, { method: 'DELETE' }).catch(() => {});
      if (state.activeSessionId === btn.dataset.delete) state.activeSessionId = null;
      await loadSessions(state);
      _renderMenu(state);
    });
  });
  menu.querySelector('[data-new-session]')?.addEventListener('click', async () => {
    menu.classList.add('hidden');
    await createSession(state);
  });
  menu.querySelectorAll('[data-connect]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      _showConnectInput(el.dataset.connect, state);
    });
  });
}

// Step 19 — repo connect: swap the menu content for a single input row.
function _showConnectInput(kind, state) {
  const menu = document.getElementById('coding-session-menu');
  if (!menu) return;
  const isPath = kind === 'path';
  menu.innerHTML = `
    <div class="coding-menu-group">${isPath ? 'Connect local folder' : 'Clone from GitHub'}</div>
    <input id="coding-connect-input" class="coding-session-rename-input" style="margin:4px 6px;width:calc(100% - 12px)"
      placeholder="${isPath ? 'C:\\\\path\\\\to\\\\repo' : 'https://github.com/owner/repo'}">
    <div id="coding-connect-status" class="coding-menu-empty" style="display:none"></div>`;
  const input  = menu.querySelector('#coding-connect-input');
  const status = menu.querySelector('#coding-connect-status');
  input.focus();
  input.addEventListener('click', e => e.stopPropagation());
  input.addEventListener('keydown', async (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { menu.classList.add('hidden'); return; }
    if (e.key !== 'Enter') return;
    const val = input.value.trim();
    if (!val) return;
    status.style.display = '';
    status.textContent = isPath ? 'Connecting…' : 'Cloning… (up to a few minutes)';
    try {
      const r = await fetch(`/api/coding/sessions/${state.activeSessionId}/connect-repo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(isPath ? { path: val } : { github_url: val }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail || `HTTP ${r.status}`);
      status.textContent = `Connected: ${data.repo} (${data.branch || 'no branch'})`;
      document.dispatchEvent(new CustomEvent('coding-session-changed',
        { detail: { sessionId: state.activeSessionId } }));
      setTimeout(() => menu.classList.add('hidden'), 900);
    } catch (err) {
      status.textContent = `Failed: ${err.message}`;
    }
  });
}

function _inlineRename(id, state) {
  const menu = document.getElementById('coding-session-menu');
  const row  = menu?.querySelector(`.coding-session-row[data-session-id="${id}"]`);
  if (!row) return;
  const current = row.querySelector('.coding-session-row-name')?.textContent || '';
  row.innerHTML = `<input class="coding-session-rename-input" value="${_esc(current)}">`;
  const input = row.querySelector('input');
  input.focus(); input.select();
  const commit = async () => {
    const name = input.value.trim() || current;
    await fetch(`/api/coding/sessions/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }).catch(() => {});
    if (state.activeSessionId === id) _setTitle(name, state);
    const r = await fetch('/api/coding/sessions').catch(() => null);
    if (r?.ok) state._sessions = await r.json();
    _renderMenu(state);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') _renderMenu(state);
    e.stopPropagation();
  });
  input.addEventListener('blur', commit);
}

export async function selectSession(id, state) {
  state.activeSessionId = id;
  try {
    const r = await fetch(`/api/coding/sessions/${id}`);
    if (!r.ok) return;
    const session = await r.json();
    state.mode        = session.mode;
    state.effortLevel = session.effort_level;
    state.model       = session.model || '';
    state.ctxTokens   = session.num_ctx || 0;
    _setTitle(session.name, state);
    renderHistory(session.messages, session.transcript);
    seedContextWheel(session.messages, state.ctxTokens);
    document.dispatchEvent(new CustomEvent('coding-session-changed', { detail: { sessionId: id } }));
  } catch (err) {
    console.warn('[coding] selectSession failed:', err);
  }
}

export async function createSession(state) {
  try {
    const r = await fetch('/api/coding/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New Session' }),
    });
    if (!r.ok) return;
    const session = await r.json();
    const lr = await fetch('/api/coding/sessions').catch(() => null);
    if (lr?.ok) state._sessions = await lr.json();
    await selectSession(session.id, state);
  } catch (err) {
    console.warn('[coding] createSession failed:', err);
  }
}

function _setTitle(name, state) {
  state.activeSessionName = name;
  const el = document.getElementById('coding-session-title');
  if (el) el.textContent = name;
}

function _esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
