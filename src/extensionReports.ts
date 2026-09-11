/**
 * Pure report / markdown builders lifted out of `extension.ts`. Every function
 * here is side-effect-free (aside from reading the active workspace folder for
 * demo-session provenance) and depends only on its arguments, so it can be unit
 * tested without activating the extension. `extension.ts` re-imports these for
 * its command handlers.
 */
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { CompressedSession } from './types';
import { ContextStore } from './contextStore';
import { effectiveConfidence } from './decay';
import { renderClaimList } from './contextProvider';
import { AzureSubsystem } from './azureDetect';

export function buildSessionPreview(session: CompressedSession): string {
  const lines = [
    '# GHCP-MEM Preview',
    '',
    `- Session: \`${session.id}\``,
    `- Workspace: ${session.workspaceName}`,
    `- Type: ${session.observationType}`,
    `- Redactions: ${session.redactionCount}`,
    `- Events captured: ${session.rawEventCount}`,
    '',
    '## Summary',
    session.summary || '_No summary available_',
    '',
    '## Files',
    ...(session.keyFiles.length ? session.keyFiles.map((f) => `- ${f}`) : ['- _None_']),
    '',
    '## Decisions',
    ...(session.decisions.length ? session.decisions.map((d) => `- ${d}`) : ['- _None_']),
  ];
  return lines.join('\n');
}

export function buildAuditReport(store: ContextStore): string {
  const sessions = store
    .getAllSessions()
    .slice()
    .sort((a, b) => b.endTime - a.endTime);
  const lines = [
    '# GHCP-MEM Memory Audit',
    '',
    '| Session | Workspace | Captured | Redactions | Retention reason |',
    '|---|---|---:|---:|---|',
  ];
  for (const s of sessions.slice(0, 100)) {
    const reason = s.userTags.includes('pinned')
      ? 'Pinned'
      : s.decisions.length > 0
        ? 'Decision-bearing'
        : s.keyTopics.length > 0
          ? 'Topic-bearing'
          : 'Recent activity';
    lines.push(
      `| \`${s.id.substring(0, 8)}\` | ${s.workspaceName} | ${s.rawEventCount} | ${s.redactionCount} | ${reason} |`,
    );
  }
  return lines.join('\n');
}

export function formatAgoSimple(ts: number): string {
  const diffMs = Date.now() - ts;
  const mins = Math.round(diffMs / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(diffMs / 3600000);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(diffMs / 86400000)}d ago`;
}

export function formatReport(
  stats: ReturnType<ContextStore['getStats']>,
  recent: CompressedSession[],
): string {
  const lines: string[] = [
    '# GHCP-MEM — Context Report',
    '',
    '## Statistics',
    `- Total sessions: **${stats.totalSessions}**`,
    `- This workspace: **${stats.workspaceSessions}**`,
    `- Total redactions applied: **${stats.totalRedactions}**`,
  ];
  if (stats.oldestSession)
    lines.push(`- Oldest session: ${new Date(stats.oldestSession).toLocaleString()}`);
  if (stats.newestSession)
    lines.push(`- Newest session: ${new Date(stats.newestSession).toLocaleString()}`);
  lines.push('', '## Recent Sessions', '');
  if (recent.length === 0) {
    lines.push('_No sessions yet._');
  } else {
    for (const s of [...recent].reverse()) lines.push(formatSessionDetail(s));
  }
  return lines.join('\n');
}

export function formatSessionDetail(s: CompressedSession): string {
  const start = new Date(s.startTime).toLocaleString();
  const dur = Math.round((s.endTime - s.startTime) / 60000);
  const lines = [
    `### [${s.observationType}] ${start} (${dur} min) — \`${s.id.substring(0, 8)}\``,
    '',
    s.summary,
    '',
  ];
  if (typeof s.confidence === 'number') {
    const eff = effectiveConfidence(s) ?? s.confidence;
    const emoji = eff >= 0.75 ? '🟢' : eff >= 0.5 ? '🟡' : '🔴';
    const mode = s.compressorMode ? ` (${s.compressorMode})` : '';
    const trunc = s.eventLogTruncated ? ', event log truncated' : '';
    const decayHint =
      Math.abs(eff - s.confidence) > 0.02
        ? ` — original ${s.confidence.toFixed(2)}, decayed to ${eff.toFixed(2)}`
        : '';
    lines.push(`**Trust:** ${emoji} confidence ${eff.toFixed(2)}${mode}${trunc}${decayHint}`);
  }
  if (s.keyFiles.length) lines.push(`**Files:** ${s.keyFiles.join(', ')}`);
  if (s.keyTopics.length) lines.push(`**Topics:** ${s.keyTopics.join(', ')}`);
  if (s.decisions.length) {
    lines.push(`**Decisions:** ${renderClaimList(s.decisions, s.decisionEvidence)}`);
  }
  if (s.problemsSolved.length) {
    lines.push(`**Solved:** ${renderClaimList(s.problemsSolved, s.problemEvidence)}`);
  }
  if (s.userTags.length) lines.push(`**Tags:** ${s.userTags.join(', ')}`);
  if (s.azureContext) {
    const ac = s.azureContext;
    lines.push(
      '**Azure:** ' +
        [
          ac.subscriptionName && `sub=${ac.subscriptionName}`,
          ac.resourceGroup && `rg=${ac.resourceGroup}`,
          ac.subsystems?.length && `subsystems=${ac.subsystems.join(',')}`,
          ac.resourceIds?.length && `resources=${ac.resourceIds.length}`,
        ]
          .filter(Boolean)
          .join(' · '),
    );
  }
  if (s.redactionCount) lines.push(`_${s.redactionCount} redaction(s) applied._`);
  lines.push('');
  return lines.join('\n');
}

export function buildAzureDemoSessions(): CompressedSession[] {
  const ws = vscode.workspace.workspaceFolders?.[0];
  const workspaceId = ws?.uri.toString() ?? 'demo-workspace';
  const workspaceName = ws?.name ?? 'demo';
  const now = Date.now();
  const hour = 3600000;
  const mk = (
    offset: number,
    observationType: CompressedSession['observationType'],
    summary: string,
    keyFiles: string[],
    keyTopics: string[],
    decisions: string[],
    problemsSolved: string[],
    subsystems: string[],
    extraTags: string[] = [],
  ): CompressedSession => ({
    id: crypto.randomUUID(),
    workspaceId,
    workspaceName,
    startTime: now - offset - 15 * 60000,
    endTime: now - offset,
    summary,
    observationType,
    keyFiles,
    keyTopics,
    decisions,
    problemsSolved,
    rawEventCount: keyFiles.length * 4 + 3,
    userTags: ['demo', 'azure', ...extraTags],
    redactionCount: 0,
    azureContext: {
      subscriptionName: 'contoso-dev',
      subscriptionId: '00000000-0000-0000-0000-000000000000',
      tenantId: '11111111-1111-1111-1111-111111111111',
      resourceGroup: 'rg-contoso-dev',
      defaultLocation: 'eastus2',
      subsystems,
      capturedAt: new Date(now - offset).toISOString(),
    },
  });

  return [
    mk(
      4 * hour,
      'infra',
      'Authored Bicep modules for a Static Web App fronted by Azure Front Door, output SWA hostname as a stackOutput. Added managedIdentity block and scoped the SWA to the app resource group.',
      ['infra/main.bicep', 'infra/modules/swa.bicep', 'infra/modules/afd.bicep', 'azure.yaml'],
      ['bicep', 'static-web-apps', 'front-door', 'managed-identity'],
      [
        'Front Door in front of SWA for global cache + WAF',
        'System-assigned identity on SWA, no keys in code',
      ],
      [],
      ['iac-bicep', 'azd'],
      ['bicep', 'swa'],
    ),
    mk(
      2 * hour,
      'deployment',
      'Ran `azd up` against contoso-dev. Deployment failed on Key Vault RBAC role assignment (principal not yet propagated); added a 30s delay + retry in infra/main.bicep module ordering and redeployed successfully.',
      ['infra/main.bicep', 'infra/modules/kv.bicep'],
      ['azd', 'key-vault', 'rbac', 'deployment'],
      ['Chain KV role assignment after managed identity creation with dependsOn'],
      ['Intermittent KV RBAC propagation failure on first deploy'],
      ['azd', 'cli'],
      ['azd', 'deployment'],
    ),
    mk(
      hour,
      'bugfix',
      'Azure Function cold-start returning 500 because DefaultAzureCredential could not find a managed identity in local dev. Added AZURE_CLIENT_ID fallback in host.json and documented the dev/prod credential chain in README.',
      ['src/functions/api/host.json', 'src/functions/api/local.settings.json', 'README.md'],
      ['azure-functions', 'defaultazurecredential', 'managed-identity'],
      ['Use VisualStudioCodeCredential in dev, ManagedIdentityCredential in prod'],
      ['500 from function on cold start due to missing credential'],
      ['functions'],
      ['functions'],
    ),
    mk(
      30 * 60000,
      'refactor',
      'Migrated AKS workload from kubectl-apply YAML to a Helm chart. Replaced raw Deployment/Service/Ingress manifests with templated values.yaml. Verified with `helm template` diff against the previous cluster state.',
      ['charts/api/Chart.yaml', 'charts/api/values.yaml', 'charts/api/templates/deployment.yaml'],
      ['aks', 'helm', 'kubectl', 'ingress'],
      ['Helm for templating + rollback history', 'Pin image tag via values.yaml, not latest'],
      [],
      ['aks'],
      ['aks', 'helm'],
    ),
    mk(
      15 * 60000,
      'security',
      'Hardened Azure Storage account: disabled shared-key access, enabled OAuth-only data plane, rotated the one remaining SAS token and replaced it with a user-delegation SAS minted from managed identity.',
      ['infra/modules/storage.bicep', 'src/api/blobClient.ts'],
      ['azure-storage', 'sas', 'rbac', 'managed-identity'],
      [
        'Shared-key disabled everywhere',
        'All SAS tokens must be user-delegation, never account-key',
      ],
      ['Inventoried and replaced 1 hardcoded SAS token'],
      ['iac-bicep', 'storage' as AzureSubsystem],
      ['storage', 'security'],
    ),
  ];
}

/** Render a compact markdown summary for `Show Current Repo Memory`. */
export function renderCurrentRepoMemoryReport(sessions: CompressedSession[]): string {
  if (sessions.length === 0) return '# No memory for this repo yet.';
  const counts = { feature: 0, bugfix: 0, refactor: 0, docs: 0, infra: 0, other: 0 };
  for (const s of sessions) {
    const k = s.observationType as keyof typeof counts;
    if (k in counts) counts[k]++;
    else counts.other++;
  }
  const recent = sessions.slice(0, 8);
  const out: string[] = [
    `# Repo memory — ${sessions[0].repoScopeLabel || sessions[0].workspaceName}`,
    '',
    `**${sessions.length}** sessions captured for this repo`,
    '',
    '## Type breakdown',
    '',
    ...Object.entries(counts)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `- **${k}**: ${n}`),
    '',
    '## Most recent 8',
    '',
  ];
  for (const s of recent) {
    const when = new Date(s.endTime).toISOString().slice(0, 10);
    out.push(`### ${when} · ${s.observationType} · \`${s.id.slice(0, 8)}\``);
    out.push('');
    out.push(s.summary || '_(no summary)_');
    if (s.decisions?.length) {
      out.push('');
      out.push('**Decisions:**');
      for (const d of s.decisions.slice(0, 3)) out.push(`- ${d}`);
    }
    out.push('');
  }
  out.push('---');
  out.push(
    '_Use_ `GHCP-MEM: Delete Current Repo Memory...` _to wipe this repo only;_ ' +
      '`GHCP-MEM: Export Current Repo Memory...` _to share it as a JSON pack._',
  );
  return out.join('\n');
}
