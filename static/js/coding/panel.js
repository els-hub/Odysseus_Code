// static/js/coding/panel.js — Claude Code Desktop-style shell
import { initSessionList, loadSessions } from './session.js';
import { initStream }    from './stream.js';
import { initModes }     from './modes.js';
import { initComposer }  from './composer.js';
import { initChipBar }   from './git.js';
import { initEffort }    from './effort.js';
import { initModelPick } from './models.js';
import { initViews, openView } from './views.js';

const _state = {
  activeSessionId: null,
  activeSessionName: 'New Session',
  model: '',
  modelLabel: 'Default',
  mode: 'auto',
  effortLevel: 2,
  streaming: false,
  fileAttachments: [],
  sendMessage: null,
  repo: '',
  branch: '',
};

let _initialized = false;
window.__codingState = _state;   // popover slider + debugging access

const ICON_CHEVRON = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;

const LAYOUT_HTML = `
<div class="coding-root">
  <div class="coding-topbar">
    <div class="coding-topbar-left">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="coding-topbar-icon">
        <rect x="2" y="4" width="20" height="16" rx="2"/><path d="m7 9 3 3-3 3"/><path d="M13 15h4"/>
      </svg>
      <span id="coding-project-name" class="coding-project-name">workspace</span>
      <button id="coding-title-btn" class="coding-title-btn" title="Sessions">
        <span id="coding-session-title">New Session</span>
        ${ICON_CHEVRON}
      </button>
      <div id="coding-session-menu" class="coding-dropdown coding-session-menu hidden"></div>
    </div>
    <div class="coding-topbar-right">
      <div class="coding-views-wrap">
        <button id="coding-views-btn" class="coding-views-btn" title="Views">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2"/><line x1="15" y1="3" x2="15" y2="21"/>
          </svg>
          ${ICON_CHEVRON}
        </button>
        <div id="coding-views-menu" class="coding-dropdown coding-views-menu hidden">
          <div class="coding-menu-item" data-view="diff">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
            <span>Diff</span><kbd>Ctrl+&#8679;+D</kbd>
          </div>
          <div class="coding-menu-item" data-view="terminal">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
            <span>Terminal</span><kbd>Ctrl+\`</kbd>
          </div>
          <div class="coding-menu-item" data-view="files">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
            <span>Files</span><kbd>Ctrl+&#8679;+F</kbd>
          </div>
          <div class="coding-menu-item" data-view="plan">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
            <span>Plan</span>
          </div>
        </div>
      </div>
      <button id="coding-close-btn" class="coding-close-btn" title="Close (Esc)">&#x2715;</button>
    </div>
  </div>

  <div class="coding-body">
    <div class="coding-main">
      <div id="coding-conversation" class="coding-conversation">
        <div class="coding-empty"><span>Start a conversation with the coding agent</span></div>
      </div>

      <div class="coding-composer-outer">
        <div class="coding-composer">
          <div id="coding-chipbar" class="coding-chipbar">
            <span id="coding-chip-repo" class="coding-chip-repo"></span>
            <span id="coding-chip-branch" class="coding-chip-branch"></span>
            <span class="coding-chipbar-spacer"></span>
            <span id="coding-chip-stat" class="coding-chip-stat"></span>
            <button id="coding-pr-btn" class="coding-pr-btn hidden">Create PR ${ICON_CHEVRON}</button>
          </div>
          <div class="coding-input-row">
            <textarea id="coding-input" class="coding-input" rows="1"
              placeholder="Message the coding agent..." aria-label="Coding message"></textarea>
            <button id="coding-send-btn" class="coding-send-btn" title="Send (Enter)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/>
              </svg>
            </button>
          </div>
          <div class="coding-toolbar">
            <div class="coding-attach-wrap">
              <button id="coding-attach-btn" class="coding-icon-btn" title="Attach (Ctrl+U)">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              </button>
              <div id="coding-attach-menu" class="coding-dropdown coding-attach-menu hidden"></div>
              <input id="coding-file-input" type="file" multiple style="display:none">
              <input id="coding-folder-input" type="file" webkitdirectory style="display:none">
            </div>
            <span class="coding-toolbar-spacer"></span>
            <span id="coding-context-wheel" class="coding-context-wheel" title="Context usage"
              data-used="0" data-max="8192" data-system="0" style="cursor:pointer">
              <svg width="16" height="16" viewBox="0 0 20 20">
                <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="2.5" opacity="0.18"/>
                <circle id="coding-context-arc" cx="10" cy="10" r="8" fill="none" stroke="currentColor"
                  stroke-width="2.5" stroke-linecap="round" stroke-dasharray="50.27"
                  stroke-dashoffset="50.27" transform="rotate(-90 10 10)"/>
              </svg>
            </span>
            <span id="coding-star" class="coding-star hidden" title="Working…">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                stroke-width="2.6" stroke-linecap="round">
                <line x1="12" y1="3" x2="12" y2="21"/>
                <line x1="3" y1="12" x2="21" y2="12"/>
                <line x1="5.6" y1="5.6" x2="18.4" y2="18.4"/>
                <line x1="18.4" y1="5.6" x2="5.6" y2="18.4"/>
              </svg>
            </span>
          </div>
          <div id="coding-file-chips" class="coding-file-chips"></div>
        </div>
      </div>
    </div>

    <div id="coding-views-panel" class="coding-views-panel hidden">
      <div class="coding-views-header">
        <span id="coding-views-title"></span>
        <button id="coding-views-refresh" class="coding-icon-btn" title="Refresh">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
        </button>
        <button id="coding-views-close" class="coding-icon-btn" title="Close panel">&#x2715;</button>
      </div>
      <div id="coding-views-content" class="coding-views-content"></div>
    </div>
  </div>
</div>
`;

export function initCodingPanel() {
  const modal = document.getElementById('coding-modal');
  if (!modal) return;

  const sidebarBtn = document.getElementById('tool-coding-btn');
  const railBtn    = document.getElementById('rail-coding');

  function openPanel() {
    modal.classList.remove('hidden');
    document.documentElement.classList.add('coding-mode-active');
    if (!_initialized) _buildLayout();
    loadSessions(_state);
    setTimeout(() => document.getElementById('coding-input')?.focus(), 80);
  }

  function closePanel() {
    modal.classList.add('hidden');
    document.documentElement.classList.remove('coding-mode-active');
  }

  sidebarBtn?.addEventListener('click', openPanel);
  railBtn?.addEventListener('click', openPanel);

  modal.addEventListener('click', (e) => {
    if (e.target.closest('#coding-close-btn')) closePanel();
  });

  document.addEventListener('keydown', (e) => {
    if (modal.classList.contains('hidden')) return;
    if (e.key === 'Escape') {
      // Close any open dropdown / views panel first, then the coding view.
      const openMenu = modal.querySelector('.coding-dropdown:not(.hidden)');
      if (openMenu) { openMenu.classList.add('hidden'); return; }
      const panel = document.getElementById('coding-views-panel');
      if (panel && !panel.classList.contains('hidden')) {
        panel.classList.add('hidden'); return;
      }
      closePanel();
    }
    // Views shortcuts (match Claude Desktop)
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'd') { e.preventDefault(); openView('diff', _state); }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); openView('files', _state); }
    if (e.ctrlKey && e.key === '`') { e.preventDefault(); openView('terminal', _state); }
  });
}

function _buildLayout() {
  const root = document.getElementById('coding-panel-root');
  if (!root) return;
  root.innerHTML = LAYOUT_HTML;

  // Views menu toggle
  const viewsBtn  = document.getElementById('coding-views-btn');
  const viewsMenu = document.getElementById('coding-views-menu');
  viewsBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    viewsMenu?.classList.toggle('hidden');
  });
  viewsMenu?.addEventListener('click', (e) => {
    const item = e.target.closest('[data-view]');
    if (!item) return;
    viewsMenu.classList.add('hidden');
    openView(item.dataset.view, _state);
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.coding-views-wrap')) viewsMenu?.classList.add('hidden');
    if (!e.target.closest('.coding-topbar-left')) {
      document.getElementById('coding-session-menu')?.classList.add('hidden');
    }
  });

  initSessionList(_state);
  initStream(_state);
  initComposer(_state);
  initModes(_state);
  initModelPick(_state);
  initEffort(_state);
  initChipBar(_state);
  initViews(_state);
  _initialized = true;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initCodingPanel);
} else {
  initCodingPanel();
}
