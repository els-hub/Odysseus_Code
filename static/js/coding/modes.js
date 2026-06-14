// static/js/coding/modes.js

const MODES = [
  { id: 'ask',    label: 'Ask',          desc: 'Read-only — no file writes' },
  { id: 'accept', label: 'Accept Edits', desc: 'Apply edits, confirm bash' },
  { id: 'plan',   label: 'Plan',         desc: 'Explore and plan, no execution' },
  { id: 'auto',   label: 'Auto',         desc: 'Execute immediately' },
  { id: 'bypass', label: 'Bypass',       desc: 'Full autonomy, no confirmations' },
];

export function initModes(state) {
  const tools = document.querySelector('.coding-toolbar');
  if (!tools) return;

  const wrap = document.createElement('div');
  wrap.style.position = 'relative';
  wrap.innerHTML = `
    <button id="coding-mode-btn" class="coding-mode-btn mode-${state.mode}">
      ${_modeLabel(state.mode)}
    </button>
    <div id="coding-mode-dropdown" class="coding-mode-dropdown">
      ${MODES.map(m => `
        <div class="coding-mode-option${m.id === state.mode ? ' selected' : ''}" data-mode-id="${m.id}">
          <span class="coding-mode-option-label">${m.label}</span>
          <span class="coding-mode-option-desc">${m.desc}</span>
        </div>`).join('')}
    </div>`;
  tools.prepend(wrap);

  const btn      = wrap.querySelector('#coding-mode-btn');
  const dropdown = wrap.querySelector('#coding-mode-dropdown');

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.toggle('open');
  });

  dropdown.querySelectorAll('.coding-mode-option').forEach(opt => {
    opt.addEventListener('click', () => {
      setMode(opt.dataset.modeId, state);
      dropdown.classList.remove('open');
    });
  });

  document.addEventListener('click', () => dropdown.classList.remove('open'));

  document.addEventListener('coding-session-changed', () => {
    btn.className = `coding-mode-btn mode-${state.mode}`;
    btn.textContent = _modeLabel(state.mode);
    dropdown.querySelectorAll('.coding-mode-option').forEach(opt => {
      opt.classList.toggle('selected', opt.dataset.modeId === state.mode);
    });
  });
}

async function setMode(modeId, state) {
  state.mode = modeId;
  const btn      = document.getElementById('coding-mode-btn');
  const dropdown = document.getElementById('coding-mode-dropdown');
  if (btn) { btn.className = `coding-mode-btn mode-${modeId}`; btn.textContent = _modeLabel(modeId); }
  dropdown?.querySelectorAll('.coding-mode-option').forEach(opt =>
    opt.classList.toggle('selected', opt.dataset.modeId === modeId));

  if (state.activeSessionId) {
    await fetch(`/api/coding/sessions/${state.activeSessionId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: modeId }),
    }).catch(() => {});
  }
}

function _modeLabel(id) {
  return MODES.find(m => m.id === id)?.label ?? id;
}
