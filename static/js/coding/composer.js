// static/js/coding/composer.js — input, '+' menu (Claude Desktop function parity)

const SLASH_COMMANDS = [
  { cmd: '/clear',   desc: 'Clear conversation' },
  { cmd: '/compact', desc: 'Summarize to save tokens' },
  { cmd: '/help',    desc: 'Show commands' },
  { cmd: '/map',     desc: 'Run repo_map on workspace' },
];

// Odysseus skills appear as slash entries too (like Claude's skill commands).
// Loaded once per page; selecting one prefixes the message with the skill.
let _skillCommands = null;
async function _loadSkillCommands() {
  if (_skillCommands) return _skillCommands;
  try {
    const r = await fetch('/api/skills');
    const skills = r.ok ? (await r.json()).skills || [] : [];
    _skillCommands = skills.slice(0, 30).map(s => ({
      cmd: '/' + String(s.name || 'skill').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      desc: (s.description || 'skill').slice(0, 60),
      skill: s.name,
    }));
  } catch { _skillCommands = []; }
  return _skillCommands;
}

// Workspace Claude-format slash commands (.claude/commands/*.md), per-session.
// Selecting one fills `/name ` — the backend expands the template body at send time.
let _wsCommands = { sid: null, list: [] };
async function _loadWorkspaceCommands(state) {
  const sid = state?.activeSessionId;
  if (!sid) return [];
  if (_wsCommands.sid === sid) return _wsCommands.list;
  try {
    const r = await fetch(`/api/coding/sessions/${sid}/commands`);
    const cmds = r.ok ? (await r.json()).commands || [] : [];
    _wsCommands = { sid, list: cmds.map(c => ({
      cmd: '/' + c.name,
      desc: (c.description || 'command').slice(0, 60),
    })) };
  } catch { _wsCommands = { sid, list: [] }; }
  return _wsCommands.list;
}

const MENU_ROOT = `
  <div class="coding-menu-item" data-action="files">
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
    <span>Add files or photos</span><kbd>Ctrl+U</kbd>
  </div>
  <div class="coding-menu-item" data-action="folder">
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
    <span>Add folder</span>
  </div>
  <div class="coding-menu-item" data-action="slash">
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="4"/><line x1="14" y1="7" x2="10" y2="17"/></svg>
    <span>Slash commands</span>
  </div>
  <div class="coding-menu-divider"></div>
  <div class="coding-menu-item" data-action="connectors">
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
    <span>Connectors</span>
    <svg class="coding-menu-arrow" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
  </div>
  <div class="coding-menu-item" data-action="plugins">
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
    <span>Plugins</span>
    <svg class="coding-menu-arrow" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
  </div>`;

const BACK_ROW = `
  <div class="coding-menu-item coding-menu-back" data-action="back">
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
    <span>Back</span>
  </div>
  <div class="coding-menu-divider"></div>`;

export function initComposer(state) {
  const input       = document.getElementById('coding-input');
  const sendBtn     = document.getElementById('coding-send-btn');
  const attachBtn   = document.getElementById('coding-attach-btn');
  const attachMenu  = document.getElementById('coding-attach-menu');
  const fileInput   = document.getElementById('coding-file-input');
  const folderInput = document.getElementById('coding-folder-input');
  if (!input) return;

  state.fileAttachments = [];

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
    _checkSlash(input, state);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); _send(state); }
    if (e.key === 'Escape') { _removeSlashMenu(); _closeAttachMenu(); }
  });

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'u') {
      const modal = document.getElementById('coding-modal');
      if (modal && !modal.classList.contains('hidden')) {
        e.preventDefault();
        fileInput?.click();
      }
    }
  });

  sendBtn?.addEventListener('click', () => _send(state));

  attachBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (attachMenu.classList.contains('hidden')) attachMenu.innerHTML = MENU_ROOT;
    attachMenu?.classList.toggle('hidden');
  });

  attachMenu?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const item = e.target.closest('[data-action]');
    if (!item) return;
    const action = item.dataset.action;

    if (action === 'files') {
      _closeAttachMenu(); fileInput?.click();
    } else if (action === 'folder') {
      _closeAttachMenu(); folderInput?.click();
    } else if (action === 'slash') {
      _closeAttachMenu();
      input.value = '/'; input.focus();
      input.dispatchEvent(new Event('input'));
    } else if (action === 'connectors') {
      await _showConnectors(attachMenu, input);
    } else if (action === 'plugins') {
      await _showPlugins(attachMenu, input);
    } else if (action === 'back') {
      attachMenu.innerHTML = MENU_ROOT;
    } else if (action === 'mcp-tool') {
      _closeAttachMenu();
      const qn = item.dataset.qualifiedName;
      input.value += (input.value ? '\n' : '') +
        '```' + qn + '\n{"param": "value"}\n```\n';
      input.focus();
      input.dispatchEvent(new Event('input'));
    } else if (action === 'skill') {
      _closeAttachMenu();
      input.value = `Use the "${item.dataset.skillName}" skill: ` + input.value;
      input.focus();
      input.dispatchEvent(new Event('input'));
    } else if (action === 'manage-connectors') {
      _closeAttachMenu(); _openSettings('integrations');
    } else if (action === 'manage-skills') {
      _closeAttachMenu(); _openBrainSkills();
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.coding-attach-wrap')) _closeAttachMenu();
  });

  fileInput?.addEventListener('change',   () => _handleFiles(fileInput.files, state));
  folderInput?.addEventListener('change', () => _handleFiles(folderInput.files, state));
}

async function _showConnectors(menu, input) {
  menu.innerHTML = BACK_ROW + '<div class="coding-menu-empty">Loading connectors…</div>';
  let tools = [];
  try {
    const r = await fetch('/api/coding/mcp-tools');
    if (r.ok) tools = (await r.json()).tools || [];
  } catch { /* empty state below */ }

  if (!tools.length) {
    menu.innerHTML = BACK_ROW + `
      <div class="coding-menu-empty">No connectors connected</div>
      <div class="coding-menu-divider"></div>
      <div class="coding-menu-item" data-action="manage-connectors"><span>Manage connectors…</span></div>`;
    return;
  }

  // Group by server.
  const byServer = {};
  for (const t of tools) (byServer[t.server_name] ||= []).push(t);

  menu.innerHTML = BACK_ROW + Object.entries(byServer).map(([server, list]) => `
    <div class="coding-menu-group">${_esc(server)}</div>
    ${list.slice(0, 12).map(t => `
      <div class="coding-menu-item" data-action="mcp-tool"
        data-qualified-name="${_esc(t.qualified_name)}" title="${_esc(t.description)}">
        <span>${_esc(t.name)}</span>
      </div>`).join('')}`).join('') + `
    <div class="coding-menu-divider"></div>
    <div class="coding-menu-item" data-action="manage-connectors"><span>Manage connectors…</span></div>`;
}

async function _showPlugins(menu, input) {
  menu.innerHTML = BACK_ROW + '<div class="coding-menu-empty">Loading plugins…</div>';
  let skills = [];
  try {
    const r = await fetch('/api/skills');
    if (r.ok) skills = (await r.json()).skills || [];
  } catch { /* empty state below */ }

  if (!skills.length) {
    menu.innerHTML = BACK_ROW + `
      <div class="coding-menu-empty">No skills installed</div>
      <div class="coding-menu-divider"></div>
      <div class="coding-menu-item" data-action="manage-skills"><span>Manage skills…</span></div>`;
    return;
  }

  menu.innerHTML = BACK_ROW + skills.slice(0, 20).map(s => `
    <div class="coding-menu-item" data-action="skill"
      data-skill-name="${_esc(s.name || s.title || 'skill')}"
      title="${_esc(s.description || '')}">
      <span>${_esc(s.name || s.title || 'skill')}</span>
    </div>`).join('') + `
    <div class="coding-menu-divider"></div>
    <div class="coding-menu-item" data-action="manage-skills"><span>Manage skills…</span></div>`;
}

function _closeAttachMenu() {
  document.getElementById('coding-attach-menu')?.classList.add('hidden');
}

function _openSettings(tab) {
  document.getElementById('user-bar-settings')?.click();
  if (tab) {
    setTimeout(() => {
      document.querySelector(`[data-settings-tab="${tab}"]`)?.click();
    }, 60);
  }
}

function _openBrainSkills() {
  document.getElementById('rail-memory')?.click();
  setTimeout(() => {
    document.querySelector('[data-memory-tab="skills"]')?.click();
  }, 60);
}

function _send(state) {
  const input = document.getElementById('coding-input');
  if (!input) return;
  const msg = input.value.trim();

  if (state.streaming) {
    if (msg) {
      // Queue the message; it fires when the current run ends.
      state.queued = state.queued || [];
      state.queued.push({ message: msg, attachments: [...(state.fileAttachments || [])] });
      input.value = ''; input.style.height = 'auto';
      state.fileAttachments = []; _renderChips(state);
      _systemNote(`Queued (#${state.queued.length}) — sends when the current run finishes.`);
    } else {
      state.stopStream?.();   // empty input + click/Enter = stop
    }
    return;
  }
  if (!msg) return;

  if (msg.startsWith('/') && _handleSlash(msg, state)) {
    input.value = '';
    input.style.height = 'auto';
    _removeSlashMenu();
    return;
  }

  const attachments = [...(state.fileAttachments || [])];
  input.value = '';
  input.style.height = 'auto';
  state.fileAttachments = [];
  _renderChips(state);
  _removeSlashMenu();

  state.sendMessage?.(msg, attachments);
}

function _systemNote(text) {
  const conv = document.getElementById('coding-conversation');
  if (!conv) return;
  const el = document.createElement('div');
  el.className = 'coding-system-note';
  el.textContent = text;
  conv.appendChild(el);
  conv.scrollTop = conv.scrollHeight;
}

function _handleSlash(cmd, state) {
  const lower = cmd.toLowerCase();
  if (lower === '/clear') {
    const conv = document.getElementById('coding-conversation');
    if (conv) conv.innerHTML = '<div class="coding-empty"><span>Conversation cleared</span></div>';
    return true;
  }
  if (lower === '/compact') {
    const sid = state.activeSessionId;
    if (!sid) return true;
    _systemNote('Compacting context…');
    fetch(`/api/coding/sessions/${sid}/compact`, { method: 'POST' })
      .then(r => r.json())
      .then(d => _systemNote(d.ok
        ? `Context compacted (${d.compacted} messages summarized).`
        : `Compact failed: ${d.error || 'unknown error'}`))
      .catch(() => {});
    return true;
  }
  if (lower === '/help') {
    _systemNote(SLASH_COMMANDS.map(c => `${c.cmd} — ${c.desc}`).join('\n'));
    return true;
  }
  if (lower === '/map') {
    state.sendMessage?.('Run repo_map on the current workspace and show me the structure.', []);
    return true;
  }
  return false;
}

async function _checkSlash(input, state) {
  const val = input.value;
  if (!val.startsWith('/')) { _removeSlashMenu(); return; }
  const query  = val.slice(1).toLowerCase();
  const skills = await _loadSkillCommands();
  const wsCmds = await _loadWorkspaceCommands(state);
  if (input.value !== val) return;          // user kept typing during fetch
  const matches = [...SLASH_COMMANDS, ...wsCmds, ...skills]
    .filter(c => c.cmd.slice(1).toLowerCase().startsWith(query)).slice(0, 12);
  if (!matches.length) { _removeSlashMenu(); return; }
  _showSlashMenu(matches, input, state);
}

function _showSlashMenu(commands, input, state) {
  _removeSlashMenu();
  const menu = document.createElement('div');
  menu.id = 'coding-slash-menu';
  const rect = input.getBoundingClientRect();
  Object.assign(menu.style, {
    position: 'fixed',
    zIndex: '100000',
    bottom: (window.innerHeight - rect.top + 4) + 'px',
    left: rect.left + 'px',
  });
  menu.innerHTML = commands.map(c => `
    <div class="coding-slash-item" data-cmd="${c.cmd}">
      <span class="coding-slash-cmd">${c.cmd}</span>
      <span class="coding-slash-desc">${c.desc}</span>
    </div>`).join('');
  menu.querySelectorAll('.coding-slash-item').forEach((el, i) => {
    // mousedown (not click) + preventDefault: fires BEFORE the input blurs, so the
    // selection always registers — a plain click was being lost to the focus/blur race.
    el.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const c = commands[i];
      if (c.skill) {
        input.value = `Use the "${c.skill}" skill: `;
        input.focus();
        _removeSlashMenu();
      } else {
        // Built-in command: run it immediately on select (no extra Enter needed).
        _removeSlashMenu();
        if (_handleSlash(c.cmd, state)) {
          input.value = ''; input.style.height = 'auto';
        } else {
          input.value = c.cmd + ' '; input.focus();
        }
      }
    });
  });
  // Append inside the coding modal so it renders above the conversation
  // (document.body put it behind the modal — same bug as the context popover).
  (document.getElementById('coding-modal') || document.body).appendChild(menu);
}

function _removeSlashMenu() {
  document.getElementById('coding-slash-menu')?.remove();
}

async function _handleFiles(files, state) {
  for (const file of files) {
    try {
      const content = await file.text();
      state.fileAttachments.push({ name: file.name, content });
    } catch {
      state.fileAttachments.push({ name: file.name, content: '[binary file]' });
    }
  }
  _renderChips(state);
}

function _renderChips(state) {
  const container = document.getElementById('coding-file-chips');
  if (!container) return;
  container.innerHTML = (state.fileAttachments || []).map((f, i) => `
    <div class="coding-file-chip">
      <span>${_esc(f.name)}</span>
      <span class="coding-chip-remove" data-index="${i}">×</span>
    </div>`).join('');
  container.querySelectorAll('.coding-chip-remove').forEach(el => {
    el.addEventListener('click', () => {
      state.fileAttachments.splice(parseInt(el.dataset.index), 1);
      _renderChips(state);
    });
  });
}

function _esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
