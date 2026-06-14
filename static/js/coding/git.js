// static/js/coding/git.js — composer chip bar: repo · branch · +N −M · Create PR

export function initChipBar(state) {
  document.addEventListener('coding-session-changed', () => refreshChipBar(state));

  document.getElementById('coding-pr-btn')?.addEventListener('click', () => {
    if (state.streaming) return;
    state.sendMessage?.('Create a pull request for the current changes.', []);
  });
}

export async function refreshChipBar(state) {
  const repoEl   = document.getElementById('coding-chip-repo');
  const branchEl = document.getElementById('coding-chip-branch');
  const statEl   = document.getElementById('coding-chip-stat');
  const prBtn    = document.getElementById('coding-pr-btn');
  const projEl   = document.getElementById('coding-project-name');
  if (!repoEl || !state.activeSessionId) return;

  try {
    const r = await fetch(`/api/coding/sessions/${state.activeSessionId}/git`);
    if (!r.ok) return _clear();
    const { branch, additions, deletions, repo } = await r.json();
    state.repo = repo || ''; state.branch = branch || '';

    if (projEl && repo) projEl.textContent = repo;
    repoEl.textContent = repo || '';
    branchEl.textContent = branch || '';
    branchEl.classList.toggle('warn', branch === 'main' || branch === 'master');

    const dirty = (additions + deletions) > 0;
    statEl.innerHTML = dirty
      ? `<span class="coding-stat-add">+${additions.toLocaleString()}</span>
         <span class="coding-stat-del">−${deletions.toLocaleString()}</span>`
      : '';

    const canPR = dirty && branch && branch !== 'main' && branch !== 'master';
    prBtn?.classList.toggle('hidden', !canPR);
  } catch {
    _clear();
  }

  function _clear() {
    repoEl.textContent = ''; branchEl.textContent = '';
    statEl.innerHTML = ''; prBtn?.classList.add('hidden');
  }
}
