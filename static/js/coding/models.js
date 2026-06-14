// static/js/coding/models.js — model picker at toolbar right.
// Same data source as Odysseus chat's picker (/api/models); selection is
// persisted on the coding session and sent with every chat turn.

export function initModelPick(state) {
  const toolbar = document.querySelector('.coding-toolbar');
  const spacer  = toolbar?.querySelector('.coding-toolbar-spacer');
  if (!toolbar || !spacer) return;

  const wrap = document.createElement('div');
  wrap.className = 'coding-model-wrap';
  wrap.innerHTML = `
    <button id="coding-model-btn" class="coding-model-btn" title="Model">
      <span id="coding-model-label">Default</span>
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
    </button>
    <div id="coding-model-menu" class="coding-dropdown coding-model-menu hidden"></div>`;
  toolbar.insertBefore(wrap, spacer.nextSibling);

  const btn  = wrap.querySelector('#coding-model-btn');
  const menu = wrap.querySelector('#coding-model-menu');

  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (menu.classList.contains('hidden')) await _renderMenu(menu, state);
    menu.classList.toggle('hidden');
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.coding-model-wrap')) menu.classList.add('hidden');
  });

  document.addEventListener('coding-session-changed', () => _setLabel(state));
  _setLabel(state);
}

async function _renderMenu(menu, state) {
  menu.innerHTML = '<div class="coding-menu-empty">Loading models…</div>';
  let items = [];
  try {
    const r = await fetch('/api/models');
    if (r.ok) {
      const data = await r.json();
      for (const host of (data.items || [])) {
        const models  = host.models || [];
        const display = host.models_display || models;
        models.forEach((id, i) => items.push({ id, label: display[i] || id }));
      }
    }
  } catch { /* fall through to empty state */ }

  if (!items.length) {
    menu.innerHTML = '<div class="coding-menu-empty">No models found</div>';
    return;
  }

  menu.innerHTML = `
    <input id="coding-model-search" class="coding-model-search" placeholder="Search models…">
    <div class="coding-model-list">
      <div class="coding-menu-item coding-model-item${!state.model ? ' selected' : ''}" data-model="">
        <span>Default</span><span class="coding-menu-sub">server default</span>
      </div>
      ${items.map(m => `
        <div class="coding-menu-item coding-model-item${m.id === state.model ? ' selected' : ''}"
          data-model="${_esc(m.id)}">
          <span>${_esc(m.label)}</span>
        </div>`).join('')}
    </div>`;

  const search = menu.querySelector('#coding-model-search');
  search.addEventListener('click', e => e.stopPropagation());
  search.addEventListener('input', () => {
    const q = search.value.toLowerCase();
    menu.querySelectorAll('.coding-model-item').forEach(el => {
      el.style.display = el.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  });
  setTimeout(() => search.focus(), 30);

  menu.querySelectorAll('.coding-model-item').forEach(el => {
    el.addEventListener('click', async () => {
      const model = el.dataset.model || '';
      state.model = model;
      menu.classList.add('hidden');
      _setLabel(state);
      if (state.activeSessionId) {
        await fetch(`/api/coding/sessions/${state.activeSessionId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model }),
        }).catch(() => {});
      }
    });
  });
}

function _setLabel(state) {
  const label = document.getElementById('coding-model-label');
  if (!label) return;
  if (!state.model) { label.textContent = 'Default'; return; }
  // Display name: strip registry prefix, like chat's models_display.
  const short = state.model.split('/').pop();
  label.textContent = short.length > 24 ? short.slice(0, 24) + '…' : short;
}

function _esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
