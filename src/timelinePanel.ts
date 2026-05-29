import * as vscode from 'vscode';
import { ContextStore } from './contextStore';
import { CompressedSession } from './types';

/** Color palette keyed by observationType — WCAG AA-safe on both light and dark. */
const TYPE_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  feature:    { bg: '#1a4731', border: '#3fb950', text: '#56d364' },
  bugfix:     { bg: '#4a1717', border: '#f85149', text: '#ff7b72' },
  refactor:   { bg: '#0d2e5c', border: '#58a6ff', text: '#79c0ff' },
  docs:       { bg: '#2c1e5c', border: '#bc8cff', text: '#d2a8ff' },
  test:       { bg: '#3d2600', border: '#e3b341', text: '#f0c040' },
  chore:      { bg: '#1c1c1c', border: '#6e7681', text: '#8b949e' },
  research:   { bg: '#3a2700', border: '#ffa657', text: '#ffb77c' },
  config:     { bg: '#002244', border: '#79c0ff', text: '#a5d6ff' },
  security:   { bg: '#4a2900', border: '#ff7b72', text: '#ffa198' },
  deployment: { bg: '#1a3320', border: '#56d364', text: '#7ee787' },
  infra:      { bg: '#2d1f3d', border: '#d2a8ff', text: '#e2c0ff' },
  unknown:    { bg: '#1c1c1c', border: '#484f58', text: '#6e7681' },
};

/**
 * Interactive visual memory timeline — a full WebviewPanel showing every session
 * as a color-coded card grouped by day. Supports type filtering, click-to-detail,
 * and a live search bar.
 */
export class MemoryTimelinePanel {
  private static instance: MemoryTimelinePanel | undefined;
  private panel: vscode.WebviewPanel;
  private storeListener: vscode.Disposable;

  private constructor(
    private readonly store: ContextStore,
    private readonly context: vscode.ExtensionContext,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'ghcpMemTimeline',
      '🧠 GHCP-MEM Timeline',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [context.extensionUri],
      },
    );

    this.panel.iconPath = new vscode.ThemeIcon('history');

    this.panel.webview.onDidReceiveMessage(msg => this.handleMessage(msg));
    this.panel.onDidDispose(() => {
      this.storeListener.dispose();
      MemoryTimelinePanel.instance = undefined;
    });

    this.storeListener = store.onChange(() => this.refresh());
    this.refresh();
  }

  static show(store: ContextStore, context: vscode.ExtensionContext): void {
    if (MemoryTimelinePanel.instance) {
      MemoryTimelinePanel.instance.panel.reveal(vscode.ViewColumn.One);
      MemoryTimelinePanel.instance.refresh();
    } else {
      MemoryTimelinePanel.instance = new MemoryTimelinePanel(store, context);
    }
  }

  private refresh(): void {
    const sessions = this.store.getAllSessions().sort((a, b) => b.startTime - a.startTime);
    this.panel.webview.html = this.buildHtml(sessions);
  }

  private handleMessage(msg: { type: string; id?: string; query?: string }): void {
    if (msg.type === 'openDetail' && msg.id) {
      vscode.commands.executeCommand('workbench.action.chat.open', {
        query: `@mem /detail ${msg.id}`,
      });
    } else if (msg.type === 'copyId' && msg.id) {
      vscode.env.clipboard.writeText(msg.id);
      vscode.window.setStatusBarMessage(`$(check) Copied session ID: ${msg.id.substring(0, 8)}`, 2500);
    } else if (msg.type === 'openSearch' && msg.query) {
      vscode.commands.executeCommand('workbench.action.chat.open', {
        query: `@mem /search ${msg.query}`,
      });
    }
  }

  private buildHtml(sessions: CompressedSession[]): string {
    const stats = {
      total: sessions.length,
      types: new Map<string, number>(),
      files: new Set<string>(),
    };
    for (const s of sessions) {
      stats.types.set(s.observationType, (stats.types.get(s.observationType) ?? 0) + 1);
      s.keyFiles.forEach(f => stats.files.add(f));
    }

    // Group sessions by calendar day
    const groups = new Map<string, CompressedSession[]>();
    for (const s of sessions) {
      const key = new Date(s.startTime).toLocaleDateString(undefined, {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      });
      const arr = groups.get(key) ?? [];
      arr.push(s);
      groups.set(key, arr);
    }

    const typeFilterPills = Array.from(new Set(sessions.map(s => s.observationType))).map(t => {
      const c = TYPE_COLORS[t] ?? TYPE_COLORS.unknown;
      return `<button class="type-pill" data-type="${t}" style="border-color:${c.border};color:${c.text}" onclick="toggleType('${t}')">${t} <span class="pill-count">${stats.types.get(t) ?? 0}</span></button>`;
    }).join('');

    const dayHtml = Array.from(groups.entries()).map(([day, daySessions]) => {
      const cards = daySessions.map(s => this.buildCard(s)).join('');
      return `
        <div class="day-group" data-types="${daySessions.map(s => s.observationType).join(',')}">
          <h2 class="day-label">
            <span class="day-icon">📅</span> ${day}
            <span class="day-count">${daySessions.length} session${daySessions.length !== 1 ? 's' : ''}</span>
          </h2>
          <div class="cards-row">${cards}</div>
        </div>`;
    }).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>GHCP-MEM Timeline</title>
<style>
  :root {
    --bg: var(--vscode-editor-background, #0d1117);
    --fg: var(--vscode-editor-foreground, #e6edf3);
    --border: var(--vscode-panel-border, #30363d);
    --surface: var(--vscode-editorWidget-background, #161b22);
    --surface2: var(--vscode-list-hoverBackground, #1c2128);
    --accent: var(--vscode-focusBorder, #1f6feb);
    --input-bg: var(--vscode-input-background, #0d1117);
    --input-fg: var(--vscode-input-foreground, #e6edf3);
    --input-border: var(--vscode-input-border, #30363d);
    --muted: var(--vscode-descriptionForeground, #8b949e);
    --radius: 8px;
    --card-width: 320px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg); color: var(--fg);
    font-family: var(--vscode-font-family, 'Segoe UI', system-ui, sans-serif);
    font-size: var(--vscode-font-size, 13px);
    line-height: 1.6;
    padding: 0;
  }
  .header {
    position: sticky; top: 0; z-index: 100;
    background: var(--bg); border-bottom: 1px solid var(--border);
    padding: 12px 20px;
    display: flex; flex-direction: column; gap: 10px;
  }
  .header-row {
    display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  }
  .logo { font-size: 22px; font-weight: 700; letter-spacing: -0.5px; }
  .logo span { color: var(--accent); }
  .stats { color: var(--muted); font-size: 12px; }
  .search-box {
    flex: 1; min-width: 220px;
    background: var(--input-bg); color: var(--input-fg);
    border: 1px solid var(--input-border); border-radius: var(--radius);
    padding: 6px 12px; font-size: 13px; outline: none;
    transition: border-color 0.15s;
  }
  .search-box:focus { border-color: var(--accent); }
  .type-filters { display: flex; gap: 6px; flex-wrap: wrap; }
  .type-pill {
    padding: 3px 10px; border-radius: 20px; border: 1px solid;
    background: transparent; cursor: pointer; font-size: 11px; font-weight: 600;
    transition: all 0.15s; opacity: 0.7;
  }
  .type-pill:hover, .type-pill.active { opacity: 1; }
  .type-pill.active { background: rgba(255,255,255,0.08); }
  .pill-count { opacity: 0.7; }
  .clear-btn {
    padding: 4px 12px; border-radius: var(--radius);
    background: var(--surface2); color: var(--muted);
    border: 1px solid var(--border); cursor: pointer; font-size: 12px;
  }
  .clear-btn:hover { color: var(--fg); }
  .timeline { padding: 20px; max-width: 1400px; margin: 0 auto; }
  .day-group { margin-bottom: 32px; }
  .day-group.hidden { display: none; }
  .day-label {
    font-size: 15px; font-weight: 600; color: var(--muted);
    margin-bottom: 12px; padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
    display: flex; align-items: center; gap: 8px;
  }
  .day-icon { font-size: 16px; }
  .day-count {
    margin-left: auto; font-size: 11px; font-weight: 400;
    background: var(--surface2); padding: 2px 8px; border-radius: 20px;
  }
  .cards-row {
    display: flex; flex-wrap: wrap; gap: 12px;
  }
  .session-card {
    width: var(--card-width); border-radius: var(--radius);
    border: 1px solid; padding: 14px;
    cursor: pointer; transition: transform 0.12s, box-shadow 0.12s;
    position: relative; overflow: hidden;
  }
  .session-card::before {
    content: ''; position: absolute; left: 0; top: 0; bottom: 0;
    width: 3px;
  }
  .session-card:hover {
    transform: translateY(-2px);
    box-shadow: 0 8px 24px rgba(0,0,0,0.4);
  }
  .session-card.filtered-out { display: none; }
  .card-header {
    display: flex; align-items: center; gap: 6px;
    margin-bottom: 8px; flex-wrap: wrap;
  }
  .type-badge {
    font-size: 10px; font-weight: 700; text-transform: uppercase;
    padding: 2px 7px; border-radius: 4px; letter-spacing: 0.5px;
    border: 1px solid currentColor;
  }
  .session-time { color: var(--muted); font-size: 11px; margin-left: auto; }
  .session-id {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 10px; color: var(--muted);
    background: var(--surface); padding: 1px 5px; border-radius: 3px;
    cursor: copy; transition: color 0.1s;
  }
  .session-id:hover { color: var(--fg); }
  .session-summary {
    font-size: 12px; line-height: 1.5; color: var(--fg);
    display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
    overflow: hidden;
    margin-bottom: 8px;
  }
  .session-meta { display: flex; flex-wrap: wrap; gap: 4px; }
  .meta-chip {
    font-size: 10px; padding: 1px 6px; border-radius: 3px;
    background: var(--surface2); color: var(--muted);
    max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .meta-chip.file { color: #79c0ff; }
  .meta-chip.topic { color: #d2a8ff; }
  .meta-chip.tag { color: #e3b341; }
  .meta-chip.branch { color: #7ee787; font-style: italic; }
  .card-actions {
    position: absolute; top: 10px; right: 10px;
    display: none; gap: 4px;
  }
  .session-card:hover .card-actions { display: flex; }
  .card-btn {
    font-size: 11px; padding: 2px 7px; border-radius: 4px;
    background: var(--surface); border: 1px solid var(--border);
    color: var(--fg); cursor: pointer;
  }
  .card-btn:hover { background: var(--surface2); }
  .empty-state {
    text-align: center; padding: 60px 20px; color: var(--muted);
  }
  .empty-state .icon { font-size: 48px; display: block; margin-bottom: 16px; }
  .no-match { text-align: center; padding: 40px; color: var(--muted); display: none; }
</style>
</head>
<body>
<div class="header">
  <div class="header-row">
    <div class="logo">🧠 <span>GHCP</span>-MEM</div>
    <div class="stats">${sessions.length} sessions · ${stats.files.size} files touched</div>
    <input class="search-box" id="searchBox" placeholder="Search summaries, files, topics…" oninput="handleSearch(this.value)" />
    <button class="clear-btn" onclick="clearAll()">✕ Clear</button>
  </div>
  <div class="type-filters" id="typeFilters">${typeFilterPills}</div>
</div>

<div class="timeline" id="timeline">
  ${sessions.length === 0 ? `
  <div class="empty-state">
    <span class="icon">🌱</span>
    <div>No sessions yet.</div>
    <div>Start coding and GHCP-MEM will automatically capture your sessions.</div>
  </div>` : dayHtml}
  <div class="no-match" id="noMatch">No sessions match your filter.</div>
</div>

<script>
  const vscode = acquireVsCodeApi();
  let activeTypes = new Set();
  let searchText = '';

  function toggleType(type) {
    if (activeTypes.has(type)) activeTypes.delete(type);
    else activeTypes.add(type);
    document.querySelectorAll('.type-pill').forEach(p => {
      p.classList.toggle('active', activeTypes.has(p.dataset.type));
    });
    applyFilters();
  }

  function handleSearch(val) {
    searchText = val.toLowerCase().trim();
    applyFilters();
  }

  function clearAll() {
    activeTypes.clear();
    searchText = '';
    document.getElementById('searchBox').value = '';
    document.querySelectorAll('.type-pill').forEach(p => p.classList.remove('active'));
    applyFilters();
  }

  function applyFilters() {
    let visibleCount = 0;
    document.querySelectorAll('.session-card').forEach(card => {
      const type = card.dataset.type;
      const text = card.dataset.text || '';
      const typeMatch = activeTypes.size === 0 || activeTypes.has(type);
      const textMatch = !searchText || text.includes(searchText);
      const visible = typeMatch && textMatch;
      card.classList.toggle('filtered-out', !visible);
      if (visible) visibleCount++;
    });

    // Hide empty day groups
    document.querySelectorAll('.day-group').forEach(g => {
      const cards = g.querySelectorAll('.session-card:not(.filtered-out)');
      g.classList.toggle('hidden', cards.length === 0);
    });

    document.getElementById('noMatch').style.display = visibleCount === 0 ? 'block' : 'none';
  }

  document.addEventListener('click', e => {
    const idEl = e.target.closest('.session-id');
    if (idEl) {
      e.stopPropagation();
      vscode.postMessage({ type: 'copyId', id: idEl.dataset.fullId });
      idEl.textContent = '✓ copied!';
      setTimeout(() => { idEl.textContent = idEl.dataset.fullId?.substring(0, 8) + '…'; }, 1500);
      return;
    }
    const btn = e.target.closest('.card-btn');
    if (btn) {
      e.stopPropagation();
      vscode.postMessage({ type: 'openDetail', id: btn.dataset.id });
      return;
    }
    const card = e.target.closest('.session-card');
    if (card) {
      vscode.postMessage({ type: 'openDetail', id: card.dataset.id });
    }
  });
</script>
</body>
</html>`;
  }

  private buildCard(s: CompressedSession): string {
    const c = TYPE_COLORS[s.observationType] ?? TYPE_COLORS.unknown;
    const time = new Date(s.startTime).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const shortId = s.id.substring(0, 8);
    const branchChip = s.branchName
      ? `<span class="meta-chip branch" title="git branch">⎇ ${htmlEscape(s.branchName)}</span>`
      : '';
    const metaChips = [
      branchChip,
      ...s.keyFiles.slice(0, 2).map(f => `<span class="meta-chip file" title="${htmlEscape(f)}">${htmlEscape(f.split('/').pop() ?? f)}</span>`),
      ...s.keyTopics.slice(0, 2).map(t => `<span class="meta-chip topic">${htmlEscape(t)}</span>`),
      ...s.userTags.slice(0, 2).map(t => `<span class="meta-chip tag">#${htmlEscape(t)}</span>`),
    ].join('');

    // Build a searchable text blob for client-side filtering
    const searchBlob = [s.summary, ...s.keyFiles, ...s.keyTopics, ...s.decisions, ...s.userTags, s.branchName ?? '']
      .join(' ')
      .toLowerCase()
      .replace(/"/g, '&quot;');

    return `<div class="session-card" data-id="${s.id}" data-type="${s.observationType}" data-text="${searchBlob}"
      style="background:${c.bg};border-color:${c.border}">
      <div style="position:absolute;left:0;top:0;bottom:0;width:3px;background:${c.border};border-radius:var(--radius) 0 0 var(--radius)"></div>
      <div class="card-header">
        <span class="type-badge" style="color:${c.text};border-color:${c.border}">${s.observationType}</span>
        <span class="session-time">${time}</span>
        <span class="session-id" data-full-id="${s.id}" title="Click to copy full ID">${shortId}…</span>
      </div>
      <div class="card-actions">
        <button class="card-btn" data-id="${s.id}">Open →</button>
      </div>
      <div class="session-summary">${htmlEscape(s.summary)}</div>
      ${metaChips ? `<div class="session-meta">${metaChips}</div>` : ''}
    </div>`;
  }
}

function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
