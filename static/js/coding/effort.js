// static/js/coding/effort.js — effort dropdown (Min/Low/Med/High/Max)

const LEVELS = [
  { label: 'Min',  desc: 'Fastest, terse'          },
  { label: 'Low',  desc: 'Quick, minimal checks'   },
  { label: 'Med',  desc: 'Balanced'                },
  { label: 'High', desc: 'Thorough, verifies work' },
  { label: 'Max',  desc: 'Exhaustive'              },
];

export function initEffort(state) {
  const toolbar = document.querySelector('.coding-toolbar');
  const star    = document.getElementById('coding-star');
  if (!toolbar) return;

  const wrap = document.createElement('div');
  wrap.className = 'coding-effort-wrap';
  wrap.innerHTML = `
    <button id="coding-effort-btn" class="coding-effort-btn" title="Effort">
      <span id="coding-effort-label">${LEVELS[state.effortLevel ?? 2].label}</span>
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
    </button>
    <div id="coding-effort-menu" class="coding-dropdown coding-effort-menu hidden">
      ${LEVELS.map((l, i) => `
        <div class="coding-menu-item coding-effort-item${i === (state.effortLevel ?? 2) ? ' selected' : ''}" data-level="${i}">
          <span>${l.label}</span><span class="coding-menu-sub">${l.desc}</span>
        </div>`).join('')}
    </div>`;
  toolbar.insertBefore(wrap, star);

  const btn  = wrap.querySelector('#coding-effort-btn');
  const menu = wrap.querySelector('#coding-effort-menu');
  const label = wrap.querySelector('#coding-effort-label');

  btn.addEventListener('click', (e) => { e.stopPropagation(); menu.classList.toggle('hidden'); });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.coding-effort-wrap')) menu.classList.add('hidden');
  });

  menu.querySelectorAll('.coding-effort-item').forEach(el => {
    el.addEventListener('click', async () => {
      const level = Math.min(4, Math.max(0, parseInt(el.dataset.level, 10) || 0));
      state.effortLevel = level;
      label.textContent = LEVELS[level].label;
      menu.querySelectorAll('.coding-effort-item').forEach(o =>
        o.classList.toggle('selected', o === el));
      menu.classList.add('hidden');
      if (state.activeSessionId) {
        await fetch(`/api/coding/sessions/${state.activeSessionId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ effort_level: level }),
        }).catch(() => {});
      }
    });
  });

  document.addEventListener('coding-session-changed', () => {
    const lvl = state.effortLevel ?? 2;
    label.textContent = LEVELS[lvl].label;
    menu.querySelectorAll('.coding-effort-item').forEach(o =>
      o.classList.toggle('selected', parseInt(o.dataset.level, 10) === lvl));
  });
}
