// static/js/coding/diff.js — +/− unified diff renderer (Claude Desktop style)

const COLLAPSE_AT = 40;

export function renderDiff(container, diffObj) {
  const text = diffObj?.text || diffObj?.diff || '';
  if (!text.trim()) { container.textContent = ''; return; }

  const file    = diffObj?.file || '';
  const added   = diffObj?.added ?? (text.match(/^\+(?!\+\+)/gm) || []).length;
  const removed = diffObj?.removed ?? (text.match(/^-(?!--)/gm) || []).length;

  const wrap = document.createElement('div');
  wrap.className = 'coding-diff';
  if (file || added || removed) {
    const head = document.createElement('div');
    head.className = 'coding-diff-head';
    head.innerHTML = `
      <span class="coding-diff-file">${_esc(file)}</span>
      ${added   ? `<span class="coding-diff-addcount">+${added}</span>` : ''}
      ${removed ? `<span class="coding-diff-delcount">−${removed}</span>` : ''}`;
    wrap.appendChild(head);
  }

  const lines = text.split('\n');
  const body  = document.createElement('div');
  body.className = 'coding-diff-body';

  const renderLines = (upTo) => {
    body.innerHTML = '';
    for (const line of lines.slice(0, upTo)) {
      const el = document.createElement('div');
      if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ')
          || line.startsWith('index ')) {
        el.className = 'coding-diff-line meta';
      } else if (line.startsWith('@@')) {
        el.className = 'coding-diff-line hunk';
      } else if (line.startsWith('+')) {
        el.className = 'coding-diff-line add';
      } else if (line.startsWith('-')) {
        el.className = 'coding-diff-line del';
      } else {
        el.className = 'coding-diff-line ctx';
      }
      el.textContent = line || ' ';
      body.appendChild(el);
    }
  };

  if (lines.length > COLLAPSE_AT) {
    renderLines(COLLAPSE_AT);
    const more = document.createElement('button');
    more.className = 'coding-diff-more';
    more.textContent = `Show full diff (${lines.length} lines)`;
    more.addEventListener('click', () => { renderLines(lines.length); more.remove(); });
    wrap.appendChild(body);
    wrap.appendChild(more);
  } else {
    renderLines(lines.length);
    wrap.appendChild(body);
  }

  container.appendChild(wrap);
}

function _esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
