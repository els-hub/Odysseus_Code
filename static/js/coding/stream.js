// static/js/coding/stream.js — Claude Desktop-style conversation renderer.
// Prose paragraphs, muted expandable "Ran …" tool rows, animated star,
// thinking rows. Tool rows are keyed by event id when present (Step 6),
// falling back to tool-name + counter for older event shapes.
import { refreshChipBar } from './git.js';

let _toolSeq = 0;

let _abortCtl = null;

export function initStream(state) {
  state.sendMessage = (message, attachments) => _sendMessage(message, attachments, state);
  state.stopStream  = () => { try { _abortCtl?.abort(); } catch { /* already done */ } };
  state.queued      = [];

  // Wire the context wheel click NOW (not lazily on first stream) so it is
  // pressable the moment the panel opens — show the popover with whatever
  // data attributes are currently on the wheel.
  const wheel = document.getElementById('coding-context-wheel');
  if (wheel && !wheel.dataset.wired) {
    wheel.dataset.wired = '1';
    wheel.addEventListener('click', (e) => { e.stopPropagation(); _toggleContextPopover(wheel); });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#coding-context-popover') &&
          !e.target.closest('#coding-context-wheel')) {
        document.getElementById('coding-context-popover')?.remove();
      }
    });
  }
}

// Sticky-bottom scroll: only auto-scroll while the user is already near the bottom,
// so they can scroll UP to read earlier output mid-stream without being yanked back down.
function _nearBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
}

// Re-render a saved session's history (called on session switch).
// Prefers the rich transcript (tool rows + thinking survive restarts);
// falls back to plain messages for older sessions.
export function renderHistory(messages, transcript) {
  const conv = document.getElementById('coding-conversation');
  if (!conv) return;
  if (transcript?.length) { _renderTranscript(conv, transcript); return; }
  if (!messages || messages.length === 0) {
    conv.innerHTML = '<div class="coding-empty"><span>Start a conversation with the coding agent</span></div>';
    return;
  }
  conv.innerHTML = '';
  for (const m of messages) {
    if (m.role === 'user') {
      conv.appendChild(_userBubble(m.content));
    } else if (m.role === 'assistant') {
      const el = document.createElement('div');
      el.className = 'coding-turn assistant';
      _renderProse(el, String(m.content ?? ''));
      conv.appendChild(el);
    }
  }
  conv.scrollTop = conv.scrollHeight;
}

function _renderTranscript(conv, transcript) {
  conv.innerHTML = '';
  let turn = null;
  const ensureTurn = () => {
    if (!turn) {
      turn = document.createElement('div');
      turn.className = 'coding-turn assistant';
      conv.appendChild(turn);
    }
    return turn;
  };
  for (const e of transcript) {
    if (e.t === 'user') {
      turn = null;
      conv.appendChild(_userBubble(e.c || ''));
    } else if (e.t === 'think') {
      const row = _makeRow('Thought', '', 'thinking done');
      row.querySelector('.coding-row-body').textContent = (e.c || '').slice(0, 3000);
      ensureTurn().appendChild(row);
    } else if (e.t === 'tool') {
      const row = _makeRow(_summarize(e.tool, e.input), e.input || '',
                           e.err ? 'error' : 'done');
      row.querySelector('.coding-row-body').textContent = e.output || '';
      ensureTurn().appendChild(row);
    } else if (e.t === 'text') {
      const el = document.createElement('div');
      el.className = 'coding-prose';
      _renderProse(el, e.c || '');
      ensureTurn().appendChild(el);
    }
  }
  conv.scrollTop = conv.scrollHeight;
}

async function _sendMessage(message, attachments, state) {
  if (!state.activeSessionId || state.streaming) return;
  const conv = document.getElementById('coding-conversation');
  if (!conv) return;

  conv.querySelector('.coding-empty')?.remove();
  conv.appendChild(_userBubble(message));

  // Assistant turn container: prose + tool rows interleave inside it.
  const turn = document.createElement('div');
  turn.className = 'coding-turn assistant';
  conv.appendChild(turn);
  conv.scrollTop = conv.scrollHeight;

  const star = document.getElementById('coding-star');
  star?.classList.remove('hidden');
  const inlineStar = document.createElement('span');
  inlineStar.className = 'coding-star coding-star-inline';
  inlineStar.innerHTML = star?.innerHTML || '✳';
  turn.appendChild(inlineStar);

  state.streaming = true;
  _abortCtl = new AbortController();
  _setStreamingUI(true);

  const rows = new Map();        // tool row elements by key
  let proseEl = null;            // current prose block
  let proseText = '';
  let thinkEl = null;
  let thinkText = '';

  const newProse = () => {
    proseEl = document.createElement('div');
    proseEl.className = 'coding-prose';
    turn.insertBefore(proseEl, inlineStar);
    proseText = '';
  };

  try {
    const r = await fetch(`/api/coding/sessions/${state.activeSessionId}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: _abortCtl.signal,
      body: JSON.stringify({
        message,
        model: state.model || '',
        file_attachments: attachments || [],
      }),
    });
    if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);

    const reader  = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') break;
        let evt;
        try { evt = JSON.parse(raw); } catch { continue; }

        if (evt.delta) {
          const stick = _nearBottom(conv);
          if (!proseEl) newProse();
          proseText += evt.delta;
          _renderProse(proseEl, proseText);
          if (stick) conv.scrollTop = conv.scrollHeight;
        } else if (evt.thinking) {
          // Reasoning-model output (Step 6 backend) — dimmed collapsible row.
          if (!thinkEl) {
            thinkEl = _makeRow('Thinking…', '', 'thinking');
            turn.insertBefore(thinkEl, inlineStar);
          }
          thinkText += evt.thinking;
          thinkEl.querySelector('.coding-row-body').textContent = thinkText.slice(-4000);
        } else if (evt.type === 'tool_start') {
          const key = evt.id ?? `${evt.tool}:${_toolSeq++}`;
          const stick = _nearBottom(conv);
          const row = _makeRow(_summarize(evt.tool, evt.input), evt.input || '', 'running');
          rows.set(String(key), row);
          turn.insertBefore(row, inlineStar);
          proseEl = null;          // next delta starts a fresh prose block
          if (stick) conv.scrollTop = conv.scrollHeight;
        } else if (evt.type === 'tool_output') {
          const key = String(evt.id ?? _lastKeyFor(rows, evt.tool));
          const row = rows.get(key) || _lastRow(rows);
          if (row) _completeRow(row, evt.output || '', !!evt.error);
        } else if (evt.type === 'diff') {
          const key = String(evt.id ?? '');
          const row = rows.get(key) || _lastRow(rows);
          if (row) _attachDiff(row, evt);
        } else if (evt.type === 'tool_progress') {
          const key = String(evt.id ?? '');
          const row = rows.get(key);
          if (row) row.querySelector('.coding-row-body').textContent =
            String(evt.text || '').slice(-2000);
        } else if (evt.type === 'title') {
          const t = document.getElementById('coding-session-title');
          if (t && evt.name) t.textContent = evt.name;
          state.activeSessionName = evt.name;
        } else if (evt.type === 'context') {
          _updateContextWheel(evt.used, evt.max, evt.system || 0);
        } else if (evt.type === 'compact') {
          const note = document.createElement('div');
          note.className = 'coding-compact-divider';
          note.textContent = `— ${evt.message || 'context compacted'} —`;
          turn.insertBefore(note, inlineStar);
        } else if (evt.type === 'error') {
          const row = _makeRow(`Error`, evt.message || 'unknown error', 'error');
          _completeRow(row, evt.message || '', true);
          turn.insertBefore(row, inlineStar);
        }
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      const note = document.createElement('div');
      note.className = 'coding-system-note';
      note.textContent = '◼ stopped by user';
      turn.insertBefore(note, inlineStar);
    } else {
      const row = _makeRow('Error', err.message, 'error');
      _completeRow(row, err.message, true);
      turn.insertBefore(row, inlineStar);
    }
  } finally {
    inlineStar.remove();
    star?.classList.add('hidden');
    state.streaming = false;
    _abortCtl = null;
    _setStreamingUI(false);
    _stampTurn(turn);
    refreshChipBar(state);
    conv.scrollTop = conv.scrollHeight;
    // Queued-while-running message: fire it now.
    const next = state.queued?.shift();
    if (next) setTimeout(() => state.sendMessage?.(next.message, next.attachments), 150);
  }
}

/* ── Rendering helpers ── */

function _userBubble(text) {
  const el = document.createElement('div');
  el.className = 'coding-turn user';
  el.textContent = text;
  return el;
}

// Minimal safe markdown: paragraphs, `inline code`, ```code blocks```, **bold**.
function _renderProse(el, text) {
  const parts = String(text).split('```');
  let html = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      const body = parts[i].replace(/^[a-zA-Z0-9_+-]*\n/, '');
      html += `<pre class="coding-codeblock"><code>${_esc(body)}</code></pre>`;
    } else {
      const safe = _esc(parts[i])
        .replace(/`([^`\n]+)`/g, '<code class="coding-inline-code">$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
      html += safe.split(/\n{2,}/).map(p =>
        p.trim() ? `<p>${p.replace(/\n/g, '<br>')}</p>` : '').join('');
    }
  }
  el.innerHTML = html;
}

function _summarize(tool, input) {
  let detail = '';
  try {
    const obj = JSON.parse(input);
    detail = obj.path || obj.command || obj.query || obj.pattern || obj.message || '';
  } catch {
    detail = String(input || '').split('\n')[0];
  }
  detail = String(detail).slice(0, 72);
  const verb = {
    read_file: 'Read', write_file: 'Wrote', edit_file: 'Edited',
    bash: 'Ran', grep: 'Searched for', glob: 'Globbed', ls: 'Listed',
    repo_map: 'Mapped repo', web_search: 'Searched web for',
    web_fetch: 'Fetched', todo_write: 'Updated todos', todo_read: 'Read todos',
    git_status: 'Checked git status', git_diff: 'Diffed', git_commit: 'Committed',
    git_create_pr: 'Created PR',
  }[tool] || `Ran ${tool}`;
  return detail ? `${verb} ${detail}` : verb;
}

function _makeRow(summary, body, kind) {
  const row = document.createElement('div');
  row.className = `coding-tool-row ${kind || ''}`;
  row.innerHTML = `
    <button class="coding-row-head">
      <span class="coding-row-summary">${_esc(summary)}</span>
      <svg class="coding-row-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="9 18 15 12 9 6"/></svg>
    </button>
    <div class="coding-row-detail hidden">
      <div class="coding-row-input">${_esc(String(body).slice(0, 2000))}</div>
      <div class="coding-row-body"></div>
    </div>`;
  row.querySelector('.coding-row-head').addEventListener('click', () => {
    row.querySelector('.coding-row-detail').classList.toggle('hidden');
    row.classList.toggle('expanded');
  });
  return row;
}

function _completeRow(row, output, isError) {
  row.classList.remove('running');
  row.classList.add(isError ? 'error' : 'done');
  const body = row.querySelector('.coding-row-body');
  if (body) body.textContent = String(output).slice(0, 6000);
  if (isError) {
    row.querySelector('.coding-row-detail')?.classList.remove('hidden');
    row.classList.add('expanded');
  }
}

function _attachDiff(row, diffObj) {
  import('./diff.js').then(mod => {
    const detail = row.querySelector('.coding-row-detail');
    if (!detail) return;
    const holder = document.createElement('div');
    detail.appendChild(holder);
    mod.renderDiff(holder, diffObj);
    detail.classList.remove('hidden');
    row.classList.add('expanded');
  }).catch(() => {});
}

function _stampTurn(turn) {
  const stamp = document.createElement('div');
  stamp.className = 'coding-turn-meta';
  const t = new Date();
  stamp.innerHTML = `
    <button class="coding-meta-btn" data-copy title="Copy">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
    </button>
    <span class="coding-meta-time" data-ts="${t.getTime()}">just now</span>`;
  stamp.querySelector('[data-copy]')?.addEventListener('click', () => {
    navigator.clipboard?.writeText(turn.innerText || '').catch(() => {});
  });
  turn.appendChild(stamp);
  _tickTimes();
}

let _timeTimer = null;
function _tickTimes() {
  if (_timeTimer) return;
  _timeTimer = setInterval(() => {
    document.querySelectorAll('.coding-meta-time[data-ts]').forEach(el => {
      const mins = Math.floor((Date.now() - Number(el.dataset.ts)) / 60000);
      el.textContent = mins < 1 ? 'just now' : mins < 60 ? `${mins}m ago`
        : `${Math.floor(mins / 60)}h ago`;
    });
  }, 30000);
}

function _lastKeyFor(rows, tool) {
  let found = '';
  for (const k of rows.keys()) if (k.startsWith(`${tool}:`)) found = k;
  return found;
}
function _lastRow(rows) {
  let last = null;
  for (const v of rows.values()) last = v;
  return last;
}

// Send button morphs into a stop button while streaming (same control,
// Claude Desktop behavior) — never disabled.
const _ICON_SEND = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg>`;
const _ICON_STOP = `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`;

function _setStreamingUI(streaming) {
  const btn = document.getElementById('coding-send-btn');
  if (!btn) return;
  btn.disabled = false;
  btn.classList.toggle('stopping', streaming);
  btn.innerHTML = streaming ? _ICON_STOP : _ICON_SEND;
  btn.title = streaming ? 'Stop (or type + Enter to queue)' : 'Send (Enter)';
}

// Exported: session.js seeds the wheel on session load so it's visible and
// clickable immediately, not only after the first streamed reply.
export function seedContextWheel(messages, maxTokens) {
  const chars = (messages || []).reduce((n, m) => n + String(m.content || '').length, 0);
  _updateContextWheel(Math.round(chars / 4), maxTokens || 16384, 6000);
}

// Step 17 — context wheel: ring fills with used/max tokens, recolors at 70/90%.
// Click toggles a Claude-style popover with the context bar.
function _updateContextWheel(used, max, system = 0) {
  const wheel = document.getElementById('coding-context-wheel');
  const arc   = document.getElementById('coding-context-arc');
  if (!wheel || !arc || !max) return;
  used = used + system;                 // total occupied = history + system prompt
  const frac = Math.min(1, used / max);
  const CIRC = 50.27;                              // 2πr for r=8
  wheel.style.display = 'inline-flex';
  arc.style.strokeDashoffset = String(CIRC * (1 - frac));
  wheel.classList.toggle('warn',   frac >= 0.7 && frac < 0.9);
  wheel.classList.toggle('danger', frac >= 0.9);
  const usedK = (used / 1000).toFixed(1), maxK = Math.round(max / 1000);
  wheel.title = `Context: ≈${usedK}K / ${maxK}K tokens (${Math.round(frac * 100)}%)`;
  wheel.dataset.used = used; wheel.dataset.max = max; wheel.dataset.system = system;
  if (!wheel.dataset.wired) {
    wheel.dataset.wired = '1';
    wheel.style.cursor = 'pointer';
    wheel.addEventListener('click', (e) => { e.stopPropagation(); _toggleContextPopover(wheel); });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#coding-context-popover')) {
        document.getElementById('coding-context-popover')?.remove();
      }
    });
  }
  // live-update the popover if open
  const pop = document.getElementById('coding-context-popover');
  if (pop) _fillContextPopover(pop, used, max, system);
  let hint = document.getElementById('coding-context-hint');
  if (frac >= 0.9) {
    if (!hint) {
      hint = document.createElement('div');
      hint.id = 'coding-context-hint';
      hint.className = 'coding-context-hint';
      hint.textContent = 'Context nearly full — /compact or start a new session.';
      document.querySelector('.coding-composer')?.prepend(hint);
    }
  } else {
    hint?.remove();
  }
}

function _toggleContextPopover(wheel) {
  const existing = document.getElementById('coding-context-popover');
  if (existing) { existing.remove(); return; }
  const pop = document.createElement('div');
  pop.id = 'coding-context-popover';
  pop.className = 'coding-context-popover';
  _fillContextPopover(pop, Number(wheel.dataset.used || 0), Number(wheel.dataset.max || 1),
                      Number(wheel.dataset.system || 0));
  const rect = wheel.getBoundingClientRect();
  Object.assign(pop.style, {
    position: 'fixed',
    zIndex: '100000',
    bottom: (window.innerHeight - rect.top + 8) + 'px',
    right: (window.innerWidth - rect.right - 8) + 'px',
  });
  // Append INSIDE the coding modal so it shares the modal's stacking context
  // and renders ON TOP of the conversation — appending to document.body put
  // it behind the modal (the bug the user saw).
  (document.getElementById('coding-modal') || document.body).appendChild(pop);
}

function _fillContextPopover(pop, used, max, system = 0) {
  const msgs = Math.max(0, used - system);
  const free = Math.max(0, max - used);
  const pct  = Math.min(100, Math.round((used / max) * 100));
  const fmt  = (n) => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
  const w    = (n) => Math.max(0.5, (n / max) * 100);
  pop.innerHTML = `
    <div class="coding-ctx-row">
      <span>Context window</span>
      <span class="coding-ctx-nums">${fmt(used)} / ${fmt(max)} (${pct}%)</span>
    </div>
    <div class="coding-ctx-bar coding-ctx-bar-seg">
      <div class="coding-ctx-seg sys" style="width:${w(system)}%"></div>
      <div class="coding-ctx-seg msg" style="width:${w(msgs)}%"></div>
    </div>
    <div class="coding-ctx-legend">
      <span><i class="dot sys"></i>System prompt <b>${fmt(system)}</b></span>
      <span><i class="dot msg"></i>Messages <b>${fmt(msgs)}</b></span>
      <span><i class="dot free"></i>Free <b>${fmt(free)}</b></span>
    </div>
    <div class="coding-ctx-hint-row">auto-compacts at 80% · /compact to do it now</div>
    <div class="coding-ctx-slider-row">
      <div class="coding-ctx-row" style="margin-bottom:4px;">
        <span>Window size</span>
        <span class="coding-ctx-nums" id="coding-ctx-slider-val">${fmt(max)} tokens</span>
      </div>
      <input type="range" id="coding-ctx-slider" min="4096" max="32768" step="4096"
        value="${Math.min(32768, Math.max(4096, max))}" style="width:100%;">
      <div class="coding-ctx-hint-row">a smaller window uses less memory and is more
        likely to stay fully on the GPU — pick the largest that fits your hardware</div>
    </div>`;
  const slider = pop.querySelector('#coding-ctx-slider');
  const valEl  = pop.querySelector('#coding-ctx-slider-val');
  slider?.addEventListener('click', e => e.stopPropagation());
  slider?.addEventListener('input', () => {
    valEl.textContent = (slider.value / 1000).toFixed(0) + 'k tokens';
  });
  slider?.addEventListener('change', async () => {
    const n = parseInt(slider.value, 10);
    const sid = window.__codingState?.activeSessionId;
    if (!sid) return;
    await fetch(`/api/coding/sessions/${sid}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ num_ctx: n }),
    }).catch(() => {});
    const wheel = document.getElementById('coding-context-wheel');
    if (wheel) { wheel.dataset.max = n; }
    valEl.textContent = (n / 1000).toFixed(0) + 'k tokens ✓ saved';
  });
}

function _esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
