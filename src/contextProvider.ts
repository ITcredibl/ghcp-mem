import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { ContextStore } from './contextStore';
import { CompressedSession, ObservationType } from './types';
import { computeHealth } from './health';
import { exportSessionMarkdown } from './markdownExport';

const execAsync = promisify(exec);

/**
 * Chat participant implementing progressive disclosure (claude-mem style
 * `search → timeline → detail`) but without any external service.
 *
 * New LM-powered commands:
 *  /standup — AI daily standup note from sessions
 *  /commit   — AI conventional commit message from staged diff + sessions
 *  /ask      — RAG Q&A over full session history
 *  /recap    — AI narrative weekly recap
 */
export class ContextProvider implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly store: ContextStore) {}

  register(): void {
    const p = vscode.chat.createChatParticipant('ghcp-mem', this.handle.bind(this));
    p.iconPath = new vscode.ThemeIcon('history');
    p.followupProvider = {
      provideFollowups(result: vscode.ChatResult, context: vscode.ChatContext): vscode.ChatFollowup[] {
        const last = context.history[context.history.length - 1];
        const cmd = last instanceof vscode.ChatRequestTurn ? last.command : undefined;
        switch (cmd) {
          case 'standup':
            return [
              { prompt: '', command: 'recap', label: '$(book) Weekly recap', participant: 'ghcp-mem' },
              { prompt: '', command: 'commit', label: '$(git-commit) Generate commit', participant: 'ghcp-mem' },
            ];
          case 'commit':
            return [
              { prompt: '', command: 'standup', label: '$(calendar) Daily standup', participant: 'ghcp-mem' },
            ];
          case 'ask':
          case 'recap':
            return [
              { prompt: '', command: 'standup', label: '$(calendar) Daily standup', participant: 'ghcp-mem' },
              { prompt: '', command: 'search', label: '$(search) Search sessions', participant: 'ghcp-mem' },
            ];
          case 'search':
            return [
              { prompt: '', command: 'recent', label: '$(history) Show recent sessions', participant: 'ghcp-mem' },
              { prompt: '', command: 'health', label: '$(pulse) Check memory health', participant: 'ghcp-mem' },
            ];
          case 'recent':
            return [
              { prompt: '', command: 'search', label: '$(search) Search sessions…', participant: 'ghcp-mem' },
              { prompt: '', command: 'timeline', label: '$(calendar) View timeline', participant: 'ghcp-mem' },
            ];
          case 'timeline':
            return [
              { prompt: '', command: 'search', label: '$(search) Search sessions…', participant: 'ghcp-mem' },
            ];
          case 'health':
            return [
              { prompt: '', command: 'status', label: '$(info) Show status', participant: 'ghcp-mem' },
            ];
          default:
            return [
              { prompt: '', command: 'recent', label: '$(history) Recent sessions', participant: 'ghcp-mem' },
              { prompt: '', command: 'health', label: '$(pulse) Memory health', participant: 'ghcp-mem' },
            ];
        }
      },
    };
    this.disposables.push(p);
  }

  private async handle(
    request: vscode.ChatRequest,
    _context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
  ): Promise<void> {
    const cmd = request.command;
    const query = request.prompt.trim();

    switch (cmd) {
      case 'status':   return this.status(stream);
      case 'recent':   return this.recent(stream);
      case 'search':   return this.search(query, stream);
      case 'timeline': return this.timeline(query, stream);
      case 'detail':   return this.detail(query, stream);
      case 'azure':    return this.azure(query, stream);
      case 'health':   return this.health(stream);
      case 'export':   return this.export(query, stream);
      case 'standup':  return this.standup(query, stream, request, token);
      case 'commit':   return this.commit(stream, request, token);
      case 'ask':      return this.ask(query, stream, request, token);
      case 'recap':    return this.recap(query, stream, request, token);
      case 'savings':  return this.savings(stream);
      case 'related':  return this.related(stream);
      case 'decisions': return this.decisions(query, stream, request, token);
      default:
        if (!query || query.toLowerCase() === 'status') return this.status(stream);
        if (query.toLowerCase() === 'recent') return this.recent(stream);
        return this.search(query, stream);
    }
  }

  private async status(stream: vscode.ChatResponseStream): Promise<void> {
    const stats = this.store.getStats();
    stream.markdown(`## Memory Status\n\n`);
    stream.markdown(`- **Total sessions:** ${stats.totalSessions}\n`);
    stream.markdown(`- **This workspace:** ${stats.workspaceSessions}\n`);
    stream.markdown(`- **Today sessions:** ${stats.todaySessions}\n`);
    stream.markdown(`- **Estimated tokens saved today:** ${stats.todayEstimatedTokensSaved.toLocaleString()}\n`);
    stream.markdown(`- **Lifetime tokens saved:** ${stats.lifetimeEstimatedTokensSaved.toLocaleString()}\n`);
    stream.markdown(`- **Avg compression ratio:** ${stats.avgCompressionRatio}×\n`);
    stream.markdown(`- **Redactions applied:** ${stats.totalRedactions}\n`);
    if (stats.oldestSession) stream.markdown(`- **Oldest:** ${new Date(stats.oldestSession).toLocaleDateString()}\n`);
    if (stats.newestSession) stream.markdown(`- **Newest:** ${new Date(stats.newestSession).toLocaleDateString()}\n`);
    stream.markdown(`\n> 💡 Run \`@mem /savings\` for a full token-savings breakdown with cost estimates.\n`);
    stream.markdown(`\n**Commands:** \`/search\`, \`/timeline\`, \`/detail <id>\`, \`/recent\`, \`/azure\`, \`/health\`, \`/export <id>\`, \`/savings\`\n`);
  }

  private async health(stream: vscode.ChatResponseStream): Promise<void> {
    const h = computeHealth(this.store.getAllSessions());
    stream.markdown(`## Memory Health: ${h.score}/100  ${h.densityGlyph}\n\n`);
    stream.markdown(`- Total sessions: **${h.totalSessions}**\n`);
    stream.markdown(`- Redaction coverage: **${h.redactionCoveragePct}%**\n`);
    stream.markdown(`- Typed (non-unknown): **${h.typedPct}%**\n`);
    stream.markdown(`- Tagged: **${h.taggedPct}%**\n`);
    stream.markdown(`- Dedup merge rate: **${Math.round(h.dedupRatio * 100)}%**\n`);
    stream.markdown(`- Retention headroom: **${h.retentionHeadroomPct}%**\n`);
    stream.markdown(`- Azure-enriched sessions: **${h.azureSessionCount}**\n`);
    if (h.notes.length) {
      stream.markdown(`\n### Notes\n\n`);
      for (const n of h.notes) stream.markdown(`- ${n}\n`);
    }
  }

  private async recent(stream: vscode.ChatResponseStream): Promise<void> {
    const recent = this.store.getRecentSessions(5);
    if (recent.length === 0) {
      stream.markdown('_No sessions recorded yet. Keep coding and memory will populate automatically._\n');
      return;
    }
    stream.markdown(`## Recent Sessions\n\n`);
    for (const s of [...recent].reverse()) this.renderCompact(s, stream);
  }

  /**
   * Layer-1 search: returns a compact index (like claude-mem's `search`).
   * Use \`/detail <id>\` to fetch full content for a specific session.
   */
  private async search(query: string, stream: vscode.ChatResponseStream): Promise<void> {
    if (!query) {
      stream.markdown('Please provide a search query.\n');
      return;
    }

    // Parse inline filters: "type:feature since:7d tag:wip foo bar"
    const { cleaned, filters } = parseInlineFilters(query);
    const results = this.store.search(cleaned, filters, 10);

    if (results.length === 0) {
      stream.markdown(`No sessions found for: "${query}"\n`);
      return;
    }

    stream.markdown(`## Search Results (${results.length})\n\n`);
    stream.markdown(`_Token-efficient index. Use \`@mem /detail <id>\` for full content._\n\n`);
    for (const s of results) this.renderIndexRow(s, stream);

    stream.markdown(`\n---\n### Synthesized Context\n\n${synthesize(results, query)}`);
  }

  /** Layer-1b timeline view — chronological window. */
  private async timeline(query: string, stream: vscode.ChatResponseStream): Promise<void> {
    let center = Date.now();
    let windowHours = 24;

    // If query is an ID, center around that session
    const maybe = query && this.store.getById(query);
    if (maybe) center = maybe.startTime;

    // Parse window spec like "72h" or "7d"
    const winMatch = query.match(/(\d+)([hdw])/);
    if (winMatch) {
      const n = parseInt(winMatch[1], 10);
      const unit = winMatch[2];
      windowHours = unit === 'h' ? n : unit === 'd' ? n * 24 : n * 24 * 7;
    }

    const results = this.store.timeline(center, windowHours, 20);
    if (results.length === 0) {
      stream.markdown(`No sessions in ±${windowHours}h window.\n`);
      return;
    }
    stream.markdown(`## Timeline (±${windowHours}h)\n\n`);
    for (const s of results) this.renderIndexRow(s, stream);
  }

  /** Layer-2 detail — fetch full content only after filtering. */
  private async detail(idPrefix: string, stream: vscode.ChatResponseStream): Promise<void> {
    if (!idPrefix) {
      stream.markdown('Provide a session ID (or prefix). Use `@mem /recent` or `/search` to find one.\n');
      return;
    }
    const s = this.store.getById(idPrefix);
    if (!s) {
      stream.markdown(`No session found for ID prefix "${idPrefix}".\n`);
      return;
    }
    this.renderFull(s, stream);
  }

  /**
   * Layer-1 Azure view — sessions that touched Azure resources, grouped by subsystem.
   * Accepts an optional filter (substring matched against summary/topics/files/resourceId).
   */
  private async azure(query: string, stream: vscode.ChatResponseStream): Promise<void> {
    const all = this.store.getAllSessions().filter(s => !!s.azureContext || s.userTags.includes('azure'));
    if (all.length === 0) {
      stream.markdown('_No Azure-tagged sessions yet. Try `GHCP-MEM: Seed Azure Demo Sessions` to see examples, or edit a `.bicep`/`azure.yaml` file._\n');
      return;
    }

    const needle = query.trim().toLowerCase();
    const filtered = !needle ? all : all.filter(s => {
      const hay = [
        s.summary,
        s.keyTopics.join(' '),
        s.keyFiles.join(' '),
        s.azureContext?.resourceGroup ?? '',
        s.azureContext?.subscriptionName ?? '',
        (s.azureContext?.resourceIds ?? []).join(' '),
      ].join(' ').toLowerCase();
      return hay.includes(needle);
    });

    if (filtered.length === 0) {
      stream.markdown(`No Azure sessions matched "${query}".\n`);
      return;
    }

    // Group by first subsystem (fallback 'azure')
    const groups = new Map<string, typeof filtered>();
    for (const s of filtered) {
      const key = s.azureContext?.subsystems?.[0] ?? 'azure';
      const arr = groups.get(key) ?? [];
      arr.push(s);
      groups.set(key, arr);
    }

    stream.markdown(`## Azure sessions (${filtered.length})${needle ? ` matching "${query}"` : ''}\n\n`);
    for (const [subsystem, sessions] of groups) {
      stream.markdown(`### ${subsystem} (${sessions.length})\n\n`);
      for (const s of sessions.slice(0, 6)) {
        const date = new Date(s.startTime).toLocaleDateString();
        const ac = s.azureContext;
        const ctxLine = ac
          ? `  \n  _${[ac.subscriptionName && `sub=${ac.subscriptionName}`, ac.resourceGroup && `rg=${ac.resourceGroup}`].filter(Boolean).join(' · ') || 'azure'}_`
          : '';
        stream.markdown(`- **[${s.observationType}]** \`${s.id.substring(0, 8)}\` · ${date}  \n  ${s.summary.substring(0, 180)}${ctxLine}\n`);
      }
    }

    stream.markdown(`\n_Use \`@mem /detail <id>\` to expand one. Tip: \`#ghcpMemSearch\` in agent mode filters by Azure too._\n`);
  }

  buildStartupContext(): string {
    const recent = this.store.getStartupCandidates(3);
    if (recent.length === 0) return '';
    const lines = ['## Previous Session Context (auto-injected by GHCP-MEM)', ''];
    for (const s of recent) {
      const when = formatInjectTimestamp(s.startTime);
      lines.push(`### ${when} · ${s.observationType} · id:\`${s.id.substring(0, 8)}\``);
      lines.push(s.summary);
      if (s.keyFiles.length) {
        const shown = s.keyFiles.slice(0, 5);
        const extra = s.keyFiles.length > shown.length ? ` (+${s.keyFiles.length - shown.length} more)` : '';
        lines.push(`Files: ${shown.join(', ')}${extra}`);
      }
      if (s.keyTopics.length) lines.push(`Topics: ${s.keyTopics.join(', ')}`);
      if (s.decisions.length) lines.push(`Decisions: ${s.decisions.join('; ')}`);
      if (s.problemsSolved.length) lines.push(`Resolved: ${s.problemsSolved.join('; ')}`);
      if (s.userTags.length) lines.push(`Tags: ${s.userTags.join(', ')}`);
      lines.push('');
    }
    return lines.join('\n');
  }

  /**
   * `/export <id|prefix>` — emit a session as a diff-friendly markdown block
   * inline in the chat. Handy for pasting into a PR description, a design
   * doc, or commit message. Falls back to "most recent" when no id is given.
   */
  private async export(idPrefix: string, stream: vscode.ChatResponseStream): Promise<void> {
    let s: CompressedSession | undefined;
    if (idPrefix) {
      s = this.store.getById(idPrefix);
    } else {
      const recent = this.store.getRecentSessions(1);
      s = recent[0];
    }
    if (!s) {
      stream.markdown(`No session found${idPrefix ? ` for ID "${idPrefix}"` : ''}.\n`);
      return;
    }
    const md = exportSessionMarkdown(s);
    stream.markdown('```markdown\n' + md + '\n```\n');
  }

  // ── LM-powered smart commands ──

  /**
   * `/standup [yesterday]` — Generate a professional daily standup note
   * from the last 24 h of coding sessions. Pass "yesterday" to scope to
   * the previous calendar day.
   */
  private async standup(
    query: string,
    stream: vscode.ChatResponseStream,
    request: vscode.ChatRequest,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const isYesterday = /yesterday|yday|ytd/i.test(query);
    const now = Date.now();
    const dayStart = new Date().setHours(0, 0, 0, 0);
    const windowStart = isYesterday ? dayStart - 86_400_000 : now - 86_400_000;
    const windowEnd = isYesterday ? dayStart : now;

    const sessions = this.store.getAllSessions().filter(
      s => s.endTime >= windowStart && s.endTime <= windowEnd && !s.userTags.includes('private'),
    );

    if (sessions.length === 0) {
      stream.markdown('_No sessions found for this time window. Keep coding and try again later!_\n');
      return;
    }

    const sessionBlocks = sessions.map(s =>
      `[${s.observationType.toUpperCase()}] ${new Date(s.startTime).toLocaleTimeString()}\n` +
      `Summary: ${s.summary}\n` +
      (s.keyFiles.length ? `Files: ${s.keyFiles.slice(0, 5).join(', ')}\n` : '') +
      (s.decisions.length ? `Decisions: ${s.decisions.join('; ')}\n` : '') +
      (s.problemsSolved.length ? `Solved: ${s.problemsSolved.join('; ')}\n` : '') +
      (s.keyTopics.length ? `Topics: ${s.keyTopics.join(', ')}\n` : ''),
    ).join('\n---\n');

    const dateLabel = isYesterday
      ? new Date(dayStart - 1).toLocaleDateString()
      : new Date().toLocaleDateString();

    const prompt = [
      'You are a senior software engineer writing a standup note for your team.',
      'Generate a concise, professional standup from the coding sessions below.',
      'Format strictly as:\n## Yesterday\n- ...\n## Today\n- ...\n## Blockers\n- ...',
      'Use past tense for Yesterday. Infer "Today" from open threads and decisions.',
      'If no blockers, write "None".',
      'Keep each bullet under 15 words. Do NOT include the raw session IDs.',
      '',
      `Sessions for ${dateLabel}:`,
      sessionBlocks,
    ].join('\n');

    stream.markdown(`## 📋 Standup · ${dateLabel}\n\n`);
    stream.markdown(`_Based on ${sessions.length} session(s) · Copy and paste into your team channel._\n\n---\n\n`);

    await this.streamLm(prompt, stream, request, token);

    stream.markdown(`\n\n---\n_Powered by GHCP-MEM · [@mem /recap](command:) for a weekly narrative · [@mem /commit](command:) for a commit message_\n`);
  }

  /**
   * `/commit` — Generate a conventional commit message from the current
   * git staged diff and any sessions that overlap the staged files.
   */
  private async commit(
    stream: vscode.ChatResponseStream,
    request: vscode.ChatRequest,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!wsRoot) {
      stream.markdown('_Open a workspace with a git repository first._\n');
      return;
    }

    let stagedFiles: string[] = [];
    let diffStat = '';
    let diffSnippet = '';

    try {
      const { stdout: names } = await execAsync('git diff --cached --name-only', { cwd: wsRoot });
      stagedFiles = names.trim().split('\n').filter(Boolean);
      const { stdout: stat } = await execAsync('git diff --cached --stat', { cwd: wsRoot });
      diffStat = stat.trim();
      // Grab a short diff snippet (first 3000 chars of actual diff)
      const { stdout: diff } = await execAsync('git diff --cached --unified=2', { cwd: wsRoot });
      diffSnippet = diff.substring(0, 3000);
    } catch {
      stream.markdown('_No staged changes found. Stage your changes with `git add` first._\n');
      return;
    }

    if (stagedFiles.length === 0) {
      stream.markdown('_No staged files found. Run `git add <files>` before using `/commit`._\n');
      return;
    }

    // Find sessions whose key files overlap with staged files
    const relatedSessions = this.store.getAllSessions().filter(s =>
      s.keyFiles.some(f => stagedFiles.some(sf => sf.includes(f) || f.includes(sf))),
    ).slice(0, 5);

    const sessionContext = relatedSessions.length
      ? '\n\nRelated coding sessions:\n' + relatedSessions.map(s =>
          `- [${s.observationType}] ${s.summary.substring(0, 150)}\n` +
          (s.decisions.length ? `  Decisions: ${s.decisions.slice(0, 2).join('; ')}\n` : '') +
          (s.problemsSolved.length ? `  Solved: ${s.problemsSolved.slice(0, 2).join('; ')}\n` : ''),
        ).join('')
      : '';

    const prompt = [
      'Generate a conventional commit message (https://conventionalcommits.org) for these staged changes.',
      'Format: <type>(<optional-scope>): <short description>',
      '',
      'Types: feat, fix, refactor, docs, test, chore, ci, perf, build',
      'Rules: imperative mood, max 72 chars for first line, optional body with "why" not "what".',
      'After the commit message, add a blank line then a short "Why:" paragraph (1-2 sentences).',
      '',
      `Staged files (${stagedFiles.length}):`,
      stagedFiles.slice(0, 20).join('\n'),
      '',
      'Git diff stat:',
      diffStat,
      '',
      'Diff snippet:',
      diffSnippet,
      sessionContext,
    ].join('\n');

    stream.markdown(`## $(git-commit) Commit Message\n\n`);
    stream.markdown(`_Staged: \`${stagedFiles.slice(0, 3).join('`, `')}${stagedFiles.length > 3 ? `\` +${stagedFiles.length - 3} more` : '`'}_\n\n`);
    stream.markdown('```\n');

    await this.streamLm(prompt, stream, request, token);

    stream.markdown('\n```\n\n');
    stream.markdown('_Copy the block above, then run `git commit -m "<message>"`_\n');
  }

  /**
   * `/ask <question>` — RAG question-answering over the full session history.
   * Finds the most relevant sessions via BM25 and uses the LM to synthesise
   * a grounded, cited answer.
   */
  private async ask(
    question: string,
    stream: vscode.ChatResponseStream,
    request: vscode.ChatRequest,
    token: vscode.CancellationToken,
  ): Promise<void> {
    if (!question) {
      stream.markdown('Ask me anything about your coding history. Example: `@mem /ask why did we change the scoring algorithm?`\n');
      return;
    }

    const { cleaned, filters } = parseInlineFilters(question);
    const hits = this.store.search(cleaned || question, filters, 8);

    if (hits.length === 0) {
      stream.markdown(`_No sessions found matching your question. Try \`@mem /search ${question}\` for a broader look._\n`);
      return;
    }

    const contextBlocks = hits.map((s, i) =>
      `[${i + 1}] Session ${s.id.substring(0, 8)} · ${new Date(s.startTime).toLocaleDateString()} · [${s.observationType}]\n` +
      `${s.summary}\n` +
      (s.keyFiles.length ? `Files: ${s.keyFiles.slice(0, 5).join(', ')}\n` : '') +
      (s.decisions.length ? `Decisions: ${s.decisions.join('; ')}\n` : '') +
      (s.problemsSolved.length ? `Solved: ${s.problemsSolved.join('; ')}\n` : ''),
    ).join('\n\n');

    const prompt = [
      'You are answering a developer\'s question about their own coding history.',
      'Answer concisely and factually based ONLY on the session context below.',
      'When citing a session, use its short ID like: (session abc12345)',
      'If the answer is not in the sessions, say so honestly.',
      '',
      `Developer's question: ${question}`,
      '',
      '--- Session context ---',
      contextBlocks,
      '--- End context ---',
    ].join('\n');

    stream.markdown(`## 🧠 Memory Answer\n\n`);
    stream.markdown(`_Searching ${hits.length} relevant session(s)…_\n\n`);

    await this.streamLm(prompt, stream, request, token);

    stream.markdown(`\n\n---\n_Cited from ${hits.length} session(s). Use \`@mem /detail <id>\` to expand any session._\n`);
  }

  /**
   * `/recap [7d|30d|this week|this month]` — AI narrative recap for
   * retrospectives, weekly reviews, or knowledge transfer docs.
   */
  private async recap(
    query: string,
    stream: vscode.ChatResponseStream,
    request: vscode.ChatRequest,
    token: vscode.CancellationToken,
  ): Promise<void> {
    let days = 7;
    const match = query.match(/(\d+)\s*d/i);
    if (match) days = Math.min(parseInt(match[1], 10), 365);
    else if (/month|30d/i.test(query)) days = 30;
    else if (/quarter|90d/i.test(query)) days = 90;

    const since = Date.now() - days * 86_400_000;
    const sessions = this.store.getAllSessions()
      .filter(s => s.endTime >= since && !s.userTags.includes('private'))
      .sort((a, b) => a.startTime - b.startTime);

    if (sessions.length === 0) {
      stream.markdown(`_No sessions in the last ${days} days._\n`);
      return;
    }

    // Group by type
    const byType = new Map<string, CompressedSession[]>();
    for (const s of sessions) {
      const arr = byType.get(s.observationType) ?? [];
      arr.push(s);
      byType.set(s.observationType, arr);
    }

    const allDecisions = Array.from(new Set(sessions.flatMap(s => s.decisions))).slice(0, 15);
    const allProblems = Array.from(new Set(sessions.flatMap(s => s.problemsSolved))).slice(0, 10);
    const allTopics = Array.from(new Set(sessions.flatMap(s => s.keyTopics))).slice(0, 20);
    const allFiles = Array.from(new Set(sessions.flatMap(s => s.keyFiles))).slice(0, 15);

    const typeBreakdown = Array.from(byType.entries())
      .map(([t, ss]) => `${t}: ${ss.length} session(s)`)
      .join(', ');

    const summaries = sessions.slice(0, 20).map(s =>
      `[${s.observationType}] ${new Date(s.startTime).toLocaleDateString()}: ${s.summary.substring(0, 200)}`,
    ).join('\n');

    const prompt = [
      `Write an engaging engineering recap for the last ${days} days of coding work.`,
      'Structure as markdown with these sections:',
      '## What We Built / What Happened',
      '## Key Decisions Made',
      '## Problems Conquered',
      '## Areas of Focus (files & technologies)',
      '## Looking Ahead (infer from open threads)',
      '',
      'Write narratively — not just bullet lists. Highlight patterns and progress.',
      `Tone: professional but human. Total length: ~300 words.`,
      '',
      `Sessions (${sessions.length} total across ${days} days):`,
      `Type breakdown: ${typeBreakdown}`,
      `Topics: ${allTopics.join(', ')}`,
      `Active files: ${allFiles.join(', ')}`,
      '',
      'Session summaries:',
      summaries,
      '',
      `Key decisions: ${allDecisions.join('; ')}`,
      `Problems solved: ${allProblems.join('; ')}`,
    ].join('\n');

    stream.markdown(`## 📰 ${days}-Day Engineering Recap\n\n`);
    stream.markdown(`_${sessions.length} sessions · ${new Date(since).toLocaleDateString()} → today_\n\n---\n\n`);

    await this.streamLm(prompt, stream, request, token);

    stream.markdown(`\n\n---\n_${sessions.length} sessions analysed · Use \`@mem /standup\` for a daily note or \`@mem /export <id>\` to share a session._\n`);
  }

  // ── Token Savings ──

  // ── Related files ──

  /**
   * `/related` — show sessions that touched the currently active editor file.
   * Zero typing needed: just open a file and run `@mem /related`.
   */
  private async related(stream: vscode.ChatResponseStream): Promise<void> {
    const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (!activeFile) {
      stream.markdown('_Open a file in the editor first, then run `@mem /related` to find sessions that touched it._\n');
      return;
    }

    const fileName = activeFile.split('/').pop() ?? activeFile;
    const rel = vscode.workspace.asRelativePath(activeFile);

    // Match by suffix or basename — sessions store relative paths
    const all = this.store.getAllSessions();
    const matches = all.filter(s =>
      s.keyFiles.some(f => {
        const fl = f.toLowerCase();
        const al = rel.toLowerCase();
        return fl === al
          || al.endsWith('/' + fl)
          || fl.endsWith('/' + al)
          || fl === fileName.toLowerCase();
      })
    ).sort((a, b) => b.endTime - a.endTime);

    if (matches.length === 0) {
      stream.markdown(`_No sessions found that touched \`${rel}\`._\n\n`);
      stream.markdown('_Note: only files captured during active coding sessions appear here._\n');
      return;
    }

    stream.markdown(`## 🔗 Sessions touching \`${rel}\`\n\n`);
    stream.markdown(`_${matches.length} session(s) found_\n\n`);

    for (const s of matches.slice(0, 15)) {
      const ago = this.formatAgo(s.endTime);
      const branch = s.branchName ? ` · \`${s.branchName}\`` : '';
      stream.markdown(`### [${s.observationType}] ${new Date(s.startTime).toLocaleDateString()} (${ago}${branch})\n\n`);
      stream.markdown(`${s.summary}\n\n`);
      if (s.decisions.length) {
        stream.markdown(`**Decisions:** ${s.decisions.slice(0, 3).join(' · ')}\n\n`);
      }
      stream.markdown(`\`${s.id.substring(0, 8)}\` · _\`@mem /detail ${s.id.substring(0, 8)}\` for full detail_\n\n---\n\n`);
    }
    if (matches.length > 15) {
      stream.markdown(`_... and ${matches.length - 15} more. Use \`@mem /search ${fileName}\` to see all._\n`);
    }
  }

  /** Format a timestamp as a human-readable "X ago" string. */
  private formatAgo(ts: number): string {
    const diff = Date.now() - ts;
    if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
    return `${Math.round(diff / 86_400_000)}d ago`;
  }

  // ── Architecture Decisions ──

  /**
   * `/decisions [filter]` — extract all decisions across sessions into a
   * structured ADR-style document. Optionally filter by keyword.
   * Great for documentation, retros, and onboarding new teammates.
   */
  private async decisions(
    query: string,
    stream: vscode.ChatResponseStream,
    request: vscode.ChatRequest,
    token: vscode.CancellationToken
  ): Promise<void> {
    let sessions = this.store.getAllSessions().filter(s => s.decisions.length > 0);

    if (query) {
      const q = query.toLowerCase();
      sessions = sessions.filter(s =>
        s.decisions.some(d => d.toLowerCase().includes(q))
        || s.keyTopics.some(t => t.toLowerCase().includes(q))
        || s.summary.toLowerCase().includes(q)
      );
    }

    if (sessions.length === 0) {
      stream.markdown(query
        ? `_No decisions found matching "${query}"._\n`
        : '_No decisions recorded yet. GHCP-MEM will extract decisions automatically as you code._\n');
      return;
    }

    // Deduplicate decisions, keeping track of when each was made
    type DecisionEntry = { decision: string; date: string; type: string; sessionId: string; branch?: string };
    const seen = new Set<string>();
    const allDecisions: DecisionEntry[] = [];

    for (const s of sessions.sort((a, b) => a.startTime - b.startTime)) {
      for (const d of s.decisions) {
        const key = d.toLowerCase().trim();
        if (!seen.has(key)) {
          seen.add(key);
          allDecisions.push({
            decision: d,
            date: new Date(s.startTime).toLocaleDateString(),
            type: s.observationType,
            sessionId: s.id.substring(0, 8),
            branch: s.branchName,
          });
        }
      }
    }

    if (allDecisions.length === 0) {
      stream.markdown('_No unique decisions found._\n');
      return;
    }

    const title = query ? `Decisions matching "${query}"` : 'All Architecture Decisions';
    stream.markdown(`## 📋 ${title}\n\n`);
    stream.markdown(`_${allDecisions.length} unique decision(s) across ${sessions.length} session(s)_\n\n`);

    // Group by type for scannability
    const byType = new Map<string, DecisionEntry[]>();
    for (const d of allDecisions) {
      const arr = byType.get(d.type) ?? [];
      arr.push(d);
      byType.set(d.type, arr);
    }

    for (const [type, entries] of Array.from(byType.entries()).sort()) {
      stream.markdown(`### ${type.charAt(0).toUpperCase() + type.slice(1)}\n\n`);
      for (const e of entries) {
        const branch = e.branch ? ` · \`${e.branch}\`` : '';
        stream.markdown(`- **${e.decision}**  \n  _${e.date}${branch} · session \`${e.sessionId}\`_\n`);
      }
      stream.markdown('\n');
    }

    // Use LM to synthesise a brief narrative if there are enough decisions
    if (allDecisions.length >= 5) {
      stream.markdown('---\n\n### 🤖 AI Summary\n\n');
      const decisionList = allDecisions.slice(0, 30).map(d => `- ${d.decision}`).join('\n');
      const prompt = [
        'Below is a list of architecture and implementation decisions extracted from a developer\'s coding sessions.',
        'Write a brief (3-5 sentence) narrative that identifies the key themes, patterns, and architectural direction these decisions reflect.',
        'Focus on what they reveal about the codebase\'s design philosophy. Be concise and insightful.',
        '',
        'Decisions:',
        decisionList,
      ].join('\n');
      await this.streamLm(prompt, stream, request, token);
    }

    stream.markdown(`\n\n---\n_Use \`@mem /decisions <keyword>\` to filter · \`@mem /detail <id>\` for session context_\n`);
  }

  /**
   * `/savings` — full token-savings breakdown with per-session table,
   * lifetime totals, compression ratio, and dollar-equivalent estimates.
   */
  private async savings(stream: vscode.ChatResponseStream): Promise<void> {
    const stats = this.store.getStats();

    if (stats.totalSessions === 0) {
      stream.markdown('_No sessions stored yet. Keep coding — GHCP-MEM will start tracking context savings automatically._\n');
      return;
    }

    // GPT-4o input pricing (May 2025): $5 / 1M tokens = $0.000005 per token
    const PRICE_PER_TOKEN = 0.000005;
    const usd = (tokens: number) => `$${(tokens * PRICE_PER_TOKEN).toFixed(2)}`;
    const fmt = (n: number) => n.toLocaleString();

    const RAW_OVERHEAD = 800;
    const sessionRow = (s: { summary?: string; keyFiles?: string[]; keyTopics?: string[]; decisions?: string[]; problemsSolved?: string[] }) => {
      const summaryChars = (s.summary ?? '').length;
      const rawChars = [
        s.summary ?? '',
        ...(s.keyFiles ?? []),
        ...(s.keyTopics ?? []),
        ...(s.decisions ?? []),
        ...(s.problemsSolved ?? []),
      ].join(' ').length + RAW_OVERHEAD;
      const rawTok = Math.round(rawChars / 4);
      const compactTok = Math.round(summaryChars / 4);
      const saved = Math.max(0, rawTok - compactTok);
      const ratio = compactTok > 0 ? (rawTok / compactTok).toFixed(1) : '—';
      return { rawTok, compactTok, saved, ratio };
    };

    // Today's sessions
    const todaySessions = this.store.getAllSessions().filter(s => {
      const d = new Date(s.endTime);
      const now = new Date();
      return d.getFullYear() === now.getFullYear()
        && d.getMonth() === now.getMonth()
        && d.getDate() === now.getDate();
    });

    stream.markdown(`## 💰 GHCP-MEM Token Savings Report\n\n`);

    // ── Today ──
    stream.markdown(`### Today (${stats.todaySessions} session${stats.todaySessions !== 1 ? 's' : ''})\n\n`);
    if (todaySessions.length === 0) {
      stream.markdown('_No sessions captured today yet._\n\n');
    } else {
      stream.markdown('| Session | Raw tokens | Compact | Saved | Ratio |\n');
      stream.markdown('|---------|-----------|---------|-------|-------|\n');
      for (const s of todaySessions.slice(-10)) {
        const r = sessionRow(s);
        const label = (s.summary ?? 'Session').substring(0, 35).replace(/\|/g, '/');
        stream.markdown(`| ${label}… | ${fmt(r.rawTok)} | ${fmt(r.compactTok)} | **${fmt(r.saved)}** | ${r.ratio}× |\n`);
      }
      stream.markdown(`\n**Today total saved: ${fmt(stats.todayEstimatedTokensSaved)} tokens** ≈ ${usd(stats.todayEstimatedTokensSaved)} (GPT-4o pricing)\n\n`);
    }

    // ── Lifetime ──
    stream.markdown(`### Lifetime (${fmt(stats.totalSessions)} sessions)\n\n`);
    stream.markdown(`| Metric | Value |\n`);
    stream.markdown(`|--------|-------|\n`);
    stream.markdown(`| Total tokens saved | **${fmt(stats.lifetimeEstimatedTokensSaved)}** |\n`);
    stream.markdown(`| Dollar equivalent | **${usd(stats.lifetimeEstimatedTokensSaved)}** (GPT-4o) |\n`);
    stream.markdown(`| Avg compression ratio | **${stats.avgCompressionRatio}×** |\n`);
    stream.markdown(`| Compact knowledge in memory | **${fmt(stats.totalCompactTokens)} tokens** |\n`);
    stream.markdown(`| Redactions applied | **${fmt(stats.totalRedactions)}** |\n`);

    // ── Interpretation ──
    const perConvSaved = stats.totalSessions > 0
      ? Math.round(stats.lifetimeEstimatedTokensSaved / stats.totalSessions)
      : 0;
    stream.markdown(`\n### 💡 What This Means\n\n`);
    stream.markdown(`- Each new Copilot chat saves you ~**${fmt(perConvSaved)} tokens** on average — context GHCP-MEM already knows.\n`);
    stream.markdown(`- You have **${fmt(stats.totalCompactTokens)} tokens** of knowledge compressed and ready to auto-inject — without re-explaining anything.\n`);
    stream.markdown(`- The **${stats.avgCompressionRatio}× avg compression ratio** means every 1 token injected replaces ${stats.avgCompressionRatio} tokens you would otherwise have typed.\n`);

    if (stats.lifetimeEstimatedTokensSaved > 10_000) {
      stream.markdown(`\n> 🏆 You've crossed **${fmt(Math.round(stats.lifetimeEstimatedTokensSaved / 1000))}K tokens saved** — that's roughly ${Math.round(stats.lifetimeEstimatedTokensSaved / 750)} pages of context you never had to re-explain!\n`);
    }

    stream.markdown(`\n---\n_Estimates: 4 chars/token heuristic · GPT-4o May 2025 input pricing ($5/1M tokens) · Run \`@mem /status\` for a quick summary._\n`);
  }

  /** Stream a language model response into the chat stream. */
  private async streamLm(
    prompt: string,
    stream: vscode.ChatResponseStream,
    request: vscode.ChatRequest,
    token: vscode.CancellationToken,
  ): Promise<void> {
    try {
      const response = await request.model.sendRequest(
        [vscode.LanguageModelChatMessage.User(prompt)],
        {},
        token,
      );
      for await (const chunk of response.stream) {
        if (chunk instanceof vscode.LanguageModelTextPart) {
          stream.markdown(chunk.value);
        }
      }
    } catch (err) {
      stream.markdown(`\n\n_Error calling language model: ${err instanceof Error ? err.message : String(err)}_\n`);
    }
  }

  // ── Rendering ──

  private renderIndexRow(s: CompressedSession, stream: vscode.ChatResponseStream): void {
    const date = new Date(s.startTime).toLocaleString();
    const tags = s.userTags.length ? ` · 🏷️ ${s.userTags.join(',')}` : '';
    const branch = s.branchName ? ` · \`${s.branchName}\`` : '';
    stream.markdown(`- **[${s.observationType}]** \`${s.id.substring(0, 8)}\` · ${date}${branch}${tags}  \n  ${s.summary.substring(0, 180)}\n`);
  }

  private renderCompact(s: CompressedSession, stream: vscode.ChatResponseStream): void {
    const start = new Date(s.startTime).toLocaleString();
    const dur = Math.round((s.endTime - s.startTime) / 60000);
    stream.markdown(`### [${s.observationType}] ${start} (${dur} min) · \`${s.id.substring(0, 8)}\`\n\n${s.summary}\n\n`);
    if (s.keyFiles.length) stream.markdown(`**Files:** ${s.keyFiles.slice(0, 5).map(f => `\`${f}\``).join(', ')}\n\n`);
    if (s.keyTopics.length) stream.markdown(`**Topics:** ${s.keyTopics.join(', ')}\n\n`);
  }

  private renderFull(s: CompressedSession, stream: vscode.ChatResponseStream): void {
    const start = new Date(s.startTime).toLocaleString();
    const end = new Date(s.endTime).toLocaleString();
    const dur = Math.round((s.endTime - s.startTime) / 60000);
    stream.markdown(`## Session \`${s.id}\`\n\n`);
    stream.markdown(`- **Type:** ${s.observationType}\n`);
    stream.markdown(`- **Workspace:** ${s.workspaceName}\n`);
    if (s.branchName) stream.markdown(`- **Branch:** \`${s.branchName}\`\n`);
    stream.markdown(`- **Started:** ${start}\n- **Ended:** ${end} (${dur} min)\n`);
    stream.markdown(`- **Events captured:** ${s.rawEventCount} · **Redactions:** ${s.redactionCount}\n`);
    if (s.userTags.length) stream.markdown(`- **User tags:** ${s.userTags.join(', ')}\n`);
    if (s.azureContext) {
      const ac = s.azureContext;
      const bits = [
        ac.subscriptionName && `sub=${ac.subscriptionName}`,
        ac.resourceGroup && `rg=${ac.resourceGroup}`,
        ac.defaultLocation && `loc=${ac.defaultLocation}`,
        ac.subsystems?.length && `subsystems=${ac.subsystems.join(',')}`,
      ].filter(Boolean).join(' · ');
      if (bits) stream.markdown(`- **Azure:** ${bits}\n`);
      if (ac.resourceIds?.length) {
        stream.markdown(`- **Resource IDs (${ac.resourceIds.length}):**\n${ac.resourceIds.slice(0, 10).map(r => `  - \`${r}\``).join('\n')}\n`);
      }
    }
    stream.markdown(`\n### Summary\n\n${s.summary}\n\n`);
    if (s.keyFiles.length) stream.markdown(`### Files\n${s.keyFiles.map(f => `- \`${f}\``).join('\n')}\n\n`);
    if (s.keyTopics.length) stream.markdown(`### Topics\n${s.keyTopics.map(t => `- ${t}`).join('\n')}\n\n`);
    if (s.decisions.length) stream.markdown(`### Decisions\n${s.decisions.map(d => `- ${d}`).join('\n')}\n\n`);
    if (s.problemsSolved.length) stream.markdown(`### Problems Solved\n${s.problemsSolved.map(p => `- ${p}`).join('\n')}\n\n`);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}

/**
 * Format a startup-inject timestamp as `M/D/YYYY HH:MM` (24h, local).
 * Exported for tests.
 */
export function formatInjectTimestamp(ts: number): string {
  const d = new Date(ts);
  const date = `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${date} ${hh}:${mm}`;
}

/**
 * Parses inline filter tokens from a search query.
 * Supported: `type:feature`, `since:7d`, `tag:wip`, `workspace:true`
 */
function parseInlineFilters(q: string): {
  cleaned: string;
  filters: import('./contextStore').SearchFilters;
} {
  const filters: import('./contextStore').SearchFilters = {};
  const tokens = q.split(/\s+/);
  const remaining: string[] = [];
  for (const tok of tokens) {
    const [k, v] = tok.split(':');
    if (!v) { remaining.push(tok); continue; }
    switch (k.toLowerCase()) {
      case 'type':
        filters.type = v as ObservationType;
        break;
      case 'since': {
        const m = v.match(/^(\d+)([hdw])$/);
        if (m) {
          const n = parseInt(m[1], 10);
          const ms = m[2] === 'h' ? n * 3600000 : m[2] === 'd' ? n * 86400000 : n * 604800000;
          filters.sinceTs = Date.now() - ms;
        }
        break;
      }
      case 'tag': filters.tag = v; break;
      case 'workspace': filters.workspaceOnly = v === 'true'; break;
      default: remaining.push(tok);
    }
  }
  return { cleaned: remaining.join(' '), filters };
}

function synthesize(sessions: CompressedSession[], query: string): string {
  const topics = new Set<string>();
  const files = new Set<string>();
  const decisions: string[] = [];
  const problems: string[] = [];
  for (const s of sessions) {
    s.keyTopics.forEach(t => topics.add(t));
    s.keyFiles.forEach(f => files.add(f));
    decisions.push(...s.decisions);
    problems.push(...s.problemsSolved);
  }
  const out: string[] = [`Based on ${sessions.length} session(s) matching "${query}":\n`];
  if (topics.size) out.push(`**Known topics:** ${Array.from(topics).join(', ')}\n`);
  if (files.size) out.push(`**Active files:** ${Array.from(files).slice(0, 8).map(f => `\`${f}\``).join(', ')}\n`);
  if (decisions.length) {
    out.push('**Decisions:**');
    for (const d of decisions.slice(0, 5)) out.push(`- ${d}`);
    out.push('');
  }
  if (problems.length) {
    out.push('**Previously solved:**');
    for (const p of problems.slice(0, 5)) out.push(`- ${p}`);
  }
  return out.join('\n');
}
