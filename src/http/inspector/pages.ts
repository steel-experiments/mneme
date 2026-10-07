/**
 * Inspector page renderers (Section 32.6 pages table).
 *
 * Each renderer is a pure function from query results to an HTML string: no
 * database access here, no clocks, no randomness — everything derives from
 * {@link queries.ts} output. Every database-derived value passes through
 * {@link h} (or a helper that does). Links use the configured base path so the
 * surface works under any `INSPECTOR_PATH`.
 */

import {
  h, badge, statusBadge, tr, trHead, kvRow, link, layout, notFoundPage,
  fmtMs, fmtNum, fmtUsd, fmtPct, excerpt, speechExcerpt,
} from './html.js';
import {
  overviewSnapshot, recentProposals, memoriesView, memoryDetailPage, listEpisodes, episodeDetailPage,
  listRuns, runDetailPage, focusedExposurePage, speechPage, channelsPage, jobsPage, auditPage, resolveEntity,
  INSPECTOR_PAGE_SIZE, type EpisodeCursor, type ChannelCursor, type ChannelListView,
  type DescTimeCursor, type SpeechView, type RunListRow,
} from './queries.js';
import { parseToolCalls, parseProvenance, buildLedger, renderLedgerSvg, TONES } from './ledger.js';
import { buildTraceRows, parseModelTurns } from './trace.js';
import type { DatabaseSync } from '../../db/database.js';
import { formatBytes } from '../../commands/status.js';
import type { ArchiveSummary } from '../../platform-archive/database.js';
import { type RetrievalGrant } from '../../db/repositories/message-search.js';
import type { MemoryArchiveCursor, MemoryArchiveSort, MemoryEvidenceCursor } from '../../memory/search.js';
import { messageLink } from '../../platform/links.js';

/** Everything a renderer needs; supplied by the router after authentication. */
export interface PageEnv {
  db: DatabaseSync;
  /** The secure review grant, recomputed per request (Section 32.6). */
  grant: RetrievalGrant;
  now: number;
  dayStartMs: number;
  basePath: string;
  /** Process readiness and effective mode for the overview; absent renders unknown. */
  runtime?: InspectorRuntimeView;
  /** The verified read-only platform archive, when configured (plan 011). */
  archive?: ArchiveSummary;
}

/** What the overview shows about process state (Section 32.6 pages table). */
export interface InspectorRuntimeView {
  ready: boolean | null;
  /** Content-free reason code from `/readyz`, or null when ready. */
  blockingReason: string | null;
  /** The effective autonomy mode: override when set, else configured. */
  mode: string | null;
  modeSource: 'override' | 'configured' | 'unknown';
}

/** A parsed inspector route; the router owns parsing, pages own rendering. */
export type InspectorRoute =
  | { name: 'overview' }
  | { name: 'memories'; q: string; type: string | null; status: string | null; sort: MemoryArchiveSort; cursor: MemoryArchiveCursor | null }
  | { name: 'memory'; id: string; evidenceCursor: MemoryEvidenceCursor | null }
  | { name: 'episodes'; cursor: EpisodeCursor | null }
  | { name: 'episode'; id: string; after: number | null }
  | { name: 'runs'; cursor: { startedAtMs: number; id: string } | null }
  | { name: 'run'; id: string; toolCallId: string | null; exposureAfter: number | null }
  | { name: 'speech'; view: SpeechView; cursor: DescTimeCursor | null }
  | { name: 'channels'; view: ChannelListView; cursor: ChannelCursor | null }
  | { name: 'jobs'; cursor: DescTimeCursor | null; status: string | null; type: string | null }
  | { name: 'audit'; cursor: DescTimeCursor | null }
  | { name: 'resolve'; id: string };

export interface RenderedPage {
  html: string;
  status: number;
}

/** Render any route; unknown or hidden entities render the shared 404 page. */
export function renderRoute(route: InspectorRoute, env: PageEnv): RenderedPage {
  switch (route.name) {
    case 'overview': return pageOverview(env);
    case 'memories': return pageMemories(route, env);
    case 'memory': return pageMemoryDetail(route, env);
    case 'episodes': return pageEpisodes(route, env);
    case 'episode': return pageEpisodeDetail(route, env);
    case 'runs': return pageRuns(route, env);
    case 'run': return pageRunDetail(route, env);
    case 'speech': return pageSpeech(route, env);
    case 'channels': return pageChannels(route, env);
    case 'jobs': return pageJobs(route, env);
    case 'audit': return pageAudit(route, env);
    case 'resolve': return pageResolve(route, env);
  }
}

// ---- Overview -----------------------------------------------------------------

/** One note about the read-only platform archive: counts and identity, no content. */
function archiveNote(a: ArchiveSummary | undefined): string {
  if (!a) return '';
  return `\n<p class="note">archive: ${h(a.platform)} · ${h(formatBytes(a.sizeBytes))} · schema ${fmtNum(a.schemaVersion)} · ${fmtNum(a.orgMessages)} org messages · ${fmtNum(a.orgMemories)} org memories · sha256 ${h(a.sha256.slice(0, 12))}</p>`;
}

function pageOverview(env: PageEnv): RenderedPage {
  const o = overviewSnapshot(env.db, env.grant, env.now, env.dayStartMs);
  const runs = listRuns(env.db, null).rows.slice(0, 8);
  const proposals = recentProposals(env.db, 5);
  const cards = [
    card(fmtNum(o.memoryActive), `active memories (${fmtNum(o.memoryTotal)} total visible)`),
    card(fmtNum(o.episodeCounts.open ?? 0), 'open episodes'),
    card(fmtNum(o.runCounts.running ?? 0), 'runs in flight'),
    card(fmtNum(o.runsToday), `runs today · ${fmtUsd(o.spendTodayUsd)}`),
    card(fmtUsd(o.spendTotalUsd), `total spend · ${fmtNum(o.inputTokensTotal ?? 0)} in / ${fmtNum(o.outputTokensTotal ?? 0)} out tokens`),
    card(
      `${fmtNum(o.detailedRunCount)} / ${fmtNum(o.totalRunCount)}`,
      `runs with detailed usage · cache-read ratio ${fmtPct(o.cacheReadRatio)}`,
    ),
    card(
      `${fmtNum(o.detailedUncachedInputTokens ?? 0)} uncached · ${fmtNum(o.detailedCacheReadTokens ?? 0)} read · ${fmtNum(o.detailedCacheWriteTokens ?? 0)} write`,
      `${fmtNum(o.detailedOutputTokens ?? 0)} output · ${o.detailedReasoningTokens === null ? 'reasoning not reported' : `${fmtNum(o.detailedReasoningTokens)} reasoning`}`,
    ),
    card(
      `${fmtNum(o.episodeShadowRuns)} shadow runs · ${fmtNum(o.episodeShadowCategoryMatches)} / ${fmtNum(o.episodeShadowCompared)} category matches`,
      `${fmtUsd(o.episodeShadowCostUsd)} shadow spend · non-acting`,
    ),
    card(fmtNum((o.proposalCounts.pending_review ?? 0)), 'proposals pending review'),
    card(fmtNum((o.outboxCounts.queued ?? 0) + (o.outboxCounts.sending ?? 0)), `queued deliveries (${fmtNum(o.outboxCounts.failed ?? 0)} failed)`),
    card(fmtNum((o.jobCounts.queued ?? 0) + (o.jobCounts.running ?? 0)), `durable jobs (${fmtNum(o.jobCounts.failed ?? 0)} failed)`),
    card(fmtNum(o.messageCount), 'live messages ingested'),
  ].join('\n');
  const runRows = runs.map((r) => tr(
    link(`${env.basePath}/runs/${h(r.id)}`, short(r.id)),
    h(r.shadowOfRunId ? `${r.runType} shadow` : r.runType),
    statusBadge(r.status),
    link(`${env.basePath}/episodes/${h(r.episodeId ?? '')}`, r.episodeId ? short(r.episodeId) : '—'),
    fmtMs(r.startedAtMs),
    runUsageCell(r),
    fmtUsd(r.costUsd),
  )).join('');
  const proposalRows = proposals.map((p) => tr(
    `<code>${h(short(p.id))}</code>`,
    statusBadge(p.status),
    h(`#${p.targetChannelName}`),
    h(excerpt(p.reason, 140)),
    fmtMs(p.createdAtMs),
  )).join('');
  const shadowRows = o.episodeShadowCohorts.map((cohort) => tr(
    h(cohort.model),
    h(cohort.thinkingLevel),
    `${fmtNum(cohort.categoryMatches)} / ${fmtNum(cohort.compared)}`,
    `${fmtNum(cohort.importantCaught)} / ${fmtNum(cohort.importantBaselines)}`,
    `${fmtNum(cohort.silentKept)} / ${fmtNum(cohort.silentBaselines)}`,
    `${fmtNum(cohort.candidateMemories)} / ${fmtNum(cohort.authoritativeMemories)}`,
    `${fmtNum(cohort.meanInputTokens ?? 0)} in · ${fmtNum(cohort.meanOutputTokens ?? 0)} out · ${fmtNum(cohort.meanReasoningTokens ?? 0)} reasoning`,
    `${fmtUsd(cohort.costUsd)} · ${fmtMs(cohort.meanExecutionMs)}`,
  )).join('');
  const runtime = env.runtime;
  const modeLine = runtime?.mode === null || runtime === undefined
    ? 'mode unknown'
    : `mode ${h(runtime.mode)} (${h(runtime.modeSource)})`;
  const readinessLine = runtime === undefined || runtime.ready === null
    ? 'readiness unknown'
    : runtime.ready
      ? 'ready'
      : `not ready (${h(runtime.blockingReason ?? 'unknown')})`;
  const scopeLine = [
    o.channelCounts.org ? `${fmtNum(o.channelCounts.org)} org` : null,
    o.channelCounts.restricted ? `${fmtNum(o.channelCounts.restricted)} restricted` : null,
    o.channelCounts.review_only ? `${fmtNum(o.channelCounts.review_only)} review-only` : null,
    o.channelCounts.excluded ? `${fmtNum(o.channelCounts.excluded)} excluded` : null,
  ].filter(Boolean).join(' · ') || 'no channels';
  const html = layout({
    title: 'Overview',
    current: 'overview',
    basePath: env.basePath,
    body: `
<h2>Overview</h2>
<p class="note">${readinessLine} · ${modeLine} · guild ${h(o.guildId ?? '—')} · channels: ${scopeLine} · grant: secure review (org, restricted, review-only).</p>${archiveNote(env.archive)}
<div class="cards">
${cards}
</div>
<h2>Episode shadow cohorts</h2>
<table>
${trHead('Candidate', 'Reasoning', 'Category match', 'Important caught', 'Silent kept', 'Memories candidate / baseline', 'Mean tokens', 'Spend · mean execution')}
${shadowRows || tr('<span class="note">No shadow cohorts yet.</span>')}
</table>
<h2>Recent runs</h2>
<table>
${trHead('Run', 'Type', 'Status', 'Episode', 'Started', 'Tokens', 'Cost')}
${runRows || tr('<span class="note">No runs yet.</span>')}
</table>
<h2>Recent proposals</h2>
<table>
${trHead('Id', 'Status', 'Channel', 'Reason', 'Created')}
${proposalRows || tr('<span class="note">No proposals yet.</span>')}
</table>
`,
  });
  return { html, status: 200 };
}

function card(n: string, label: string): string {
  return `<div class="card"><div class="n">${n}</div><div class="l">${h(label)}</div></div>`;
}

// ---- Memories -------------------------------------------------------------------

const MEMORY_TYPES = ['decision', 'assumption', 'prediction', 'fact', 'risk', 'commitment', 'experiment', 'disagreement', 'constraint', 'open_question'];
const MEMORY_STATUSES = ['active', 'superseded', 'resolved', 'invalidated', 'expired'];

function pageMemories(route: Extract<InspectorRoute, { name: 'memories' }>, env: PageEnv): RenderedPage {
  const view = memoriesView(env.db, env.grant, {
    q: route.q,
    type: route.type,
    status: route.status,
    sort: route.sort,
    now: env.now,
    cursor: route.cursor,
  });
  const typeOptions = ['<option value="">any type</option>', ...MEMORY_TYPES.map((t) =>
    `<option value="${h(t)}"${route.type === t ? ' selected' : ''}>${h(t)}</option>`)].join('');
  const statusOptions = [
    '<option value="">active</option>',
    `<option value="any"${route.status === 'any' ? ' selected' : ''}>any status</option>`,
    ...MEMORY_STATUSES.map((s) =>
      `<option value="${h(s)}"${route.status === s ? ' selected' : ''}>${h(s)}</option>`),
  ].join('');
  const form = `
<form class="get" method="get" action="${h(env.basePath)}/memories">
  <input type="search" name="q" value="${h(route.q)}" placeholder="FTS query (optional)" maxlength="200" size="32">
  <select name="type">${typeOptions}</select>
  <select name="status">${statusOptions}</select>
  <select name="sort">
    <option value="importance"${route.sort === 'importance' ? ' selected' : ''}>importance</option>
    <option value="recent"${route.sort === 'recent' ? ' selected' : ''}>most recent</option>
  </select>
  <button type="submit">Apply</button>
</form>`;

  let summaryLine: string;
  let rows: string;
  let pager = '';
  if (view.mode === 'search') {
    summaryLine = `${view.results.length} result(s) for ${h(view.query)} (ranked; cap ${INSPECTOR_PAGE_SIZE}).`;
    rows = view.results.map((m) => tr(
      link(`${env.basePath}/memories/${h(m.memoryId)}`, short(m.memoryId)),
      h(m.type),
      statusBadge(m.status),
      scopeBadge(m.scopeType, m.scopeKey),
      h(m.statement),
      fmtMs(m.lastConfirmedAtMs),
      `${fmtPct(m.confidence)} conf · ${fmtPct(m.importance)} imp · ${fmtNum(m.evidenceCount)} evidence`,
    )).join('');
  } else {
    const p = view.page;
    summaryLine = `Showing ${p.items.length} of ${fmtNum(p.totalMatching)} visible memories, ordered by ${route.sort === 'recent' ? 'most recent confirmation' : 'importance and confirmation time'}.`;
    rows = p.items.map((m) => tr(
      link(`${env.basePath}/memories/${h(m.memoryId)}`, short(m.memoryId)),
      h(m.type),
      statusBadge(m.status),
      scopeBadge(m.scopeType, m.scopeKey),
      h(m.statement),
      fmtMs(m.lastConfirmedAtMs),
      `${fmtPct(m.confidence)} conf · ${fmtPct(m.importance)} imp · ${fmtNum(m.evidenceCount)} evidence`,
    )).join('');
    const filterParams = {
      ...(route.type ? { type: route.type } : {}),
      ...(route.status ? { status: route.status } : {}),
      ...(route.sort === 'recent' ? { sort: route.sort } : {}),
    };
    const firstQuery = new URLSearchParams(filterParams).toString();
    const nextQuery = p.next
      ? new URLSearchParams({
          ...filterParams,
          ...(p.next.importance === undefined ? {} : { beforeImportance: String(p.next.importance) }),
          beforeConfirmed: String(p.next.lastConfirmedAtMs),
          beforeId: p.next.id,
        }).toString()
      : null;
    pager = [
      route.cursor ? `<a href="${h(env.basePath)}/memories${firstQuery ? `?${h(firstQuery)}` : ''}">← First page</a>` : '',
      nextQuery ? `<a href="${h(env.basePath)}/memories?${h(nextQuery)}">Next page →</a>` : '',
    ].filter(Boolean).join(' · ');
  }
  const html = layout({
    title: 'Memories',
    current: 'memories',
    basePath: env.basePath,
    body: `
<h2>Memories</h2>
${form}
<p class="note">${summaryLine}</p>
<table>
${trHead('Id', 'Type', 'Status', 'Scope', 'Statement', 'Last confirmed', 'Signals')}
${rows || tr('<span class="note">Nothing matched.</span>')}
</table>
${pager ? `<p class="pager">${pager}</p>` : ''}
`,
  });
  return { html, status: 200 };
}

function scopeBadge(scopeType: string, scopeKey: string | null): string {
  if (scopeType === 'org') return badge('org', 'scope');
  if (scopeType === 'review_only') return badge('review-only', 'warn');
  return badge(`channel ${short(scopeKey ?? '')}`, 'neutral');
}

function pageMemoryDetail(route: Extract<InspectorRoute, { name: 'memory' }>, env: PageEnv): RenderedPage {
  const data = memoryDetailPage(env.db, env.grant, route.id, env.now, route.evidenceCursor);
  if (!data) return { html: notFoundPage(env.basePath, `Memory ${route.id}`), status: 404 };
  const d = data.details;
  const details = `<dl class="details">
${kvRow('Id', `<code>${h(d.memoryId)}</code>`)}
${kvRow('Type', h(d.type))}
${kvRow('Status', statusBadge(d.status))}
${kvRow('Effective scope', scopeBadge(d.scopeType, d.scopeKey))}
${kvRow('Confidence', fmtPct(d.confidence))}
${kvRow('Importance', fmtPct(d.importance))}
${kvRow('Owner user', d.ownerUserId ? `<code>${h(d.ownerUserId)}</code>` : '—')}
${kvRow('Review after', d.reviewAfterMs === null ? '—' : fmtMs(d.reviewAfterMs))}
${kvRow('Created', fmtMs(data.createdAtMs))}
${kvRow('Last updated', fmtMs(data.updatedAtMs))}
${kvRow('Supersedes', data.lineage.supersedes
  ? link(`${env.basePath}/memories/${h(data.supersedesId)}`, short(data.supersedesId ?? '')) + ' ' + h(data.lineage.supersedes.statement)
  : data.supersedesId ? `${h(data.supersedesId)} (not visible under the grant)` : '—')}
${kvRow('Superseded by', data.lineage.supersededBy.length > 0
  ? data.lineage.supersededBy.map((m) => link(`${env.basePath}/memories/${h(m.memoryId)}`, short(m.memoryId))).join(', ')
  : '—')}
${kvRow('Links', data.lineage.links.length > 0
  ? data.lineage.links.map((l) =>
    // link() escapes its label, so the statement excerpt must arrive raw.
    `${h(l.relation)} → ${l.other ? link(`${env.basePath}/memories/${h(l.otherId)}`, `${short(l.otherId)} ${excerpt(l.other.statement, 60)}`) : `${h(l.otherId)} (hidden)`}`).join('<br>')
  : '—')}
</dl>`;

  const evidence = data.evidence.length > 0
    ? data.evidence.map((e) => `<blockquote class="evidence"><strong>${h(e.stance)}</strong> · ${h(e.authorDisplayName)} · ${fmtMs(e.createdAtMs)} · <a href="${h(e.link)}" rel="noreferrer">Discord</a><br>${h(e.content)}</blockquote>`).join('\n')
    : '<p class="note">No permitted evidence rows.</p>';
  const evidenceNextQuery = data.evidenceNext
    ? new URLSearchParams({
        evidenceAfter: String(data.evidenceNext.createdAtMs),
        evidenceMessage: data.evidenceNext.messageId,
        evidenceStance: data.evidenceNext.stance,
      }).toString()
    : null;
  const evidencePager = [
    route.evidenceCursor ? `<a href="${h(env.basePath)}/memories/${h(route.id)}">← First evidence page</a>` : '',
    evidenceNextQuery ? `<a href="${h(env.basePath)}/memories/${h(route.id)}?${h(evidenceNextQuery)}">Later evidence →</a>` : '',
  ].filter(Boolean).join(' · ');

  const reassessments = data.reassessments.length > 0
    ? `<table>${trHead('Run', 'Type', 'Status', 'Started')}${data.reassessments.map((r) => tr(
        link(`${env.basePath}/runs/${h(r.runId)}`, short(r.runId)),
        h(r.runType ?? '—'),
        statusBadge(r.status ?? '—'),
        fmtMs(r.startedAtMs),
      )).join('')}</table>`
    : '<p class="note">No run proposals referenced this memory (recent scan).</p>';

  const html = layout({
    title: `Memory ${short(d.memoryId)}`,
    current: 'memories',
    basePath: env.basePath,
    body: `
<h2>${h(d.type)} · ${h(d.statement)}</h2>
${details}
<h2>Evidence (${data.evidence.length} shown of ${fmtNum(data.evidenceTotal)}, oldest first)</h2>
${evidence}
${evidencePager ? `<p class="pager">${evidencePager}</p>` : ''}
<h2>Reassessment runs</h2>
${reassessments}
`,
  });
  return { html, status: 200 };
}

// ---- Episodes ---------------------------------------------------------------------

function pageEpisodes(route: Extract<InspectorRoute, { name: 'episodes' }>, env: PageEnv): RenderedPage {
  const { rows, next } = listEpisodes(env.db, env.grant, route.cursor);
  const body = rows.map((e) => tr(
    link(`${env.basePath}/episodes/${h(e.id)}`, short(e.id)),
    h(`#${e.channelName}`),
    statusBadge(e.status),
    fmtMs(e.lastActivityAtMs),
    fmtNum(e.humanMessageCount),
    e.interventionScore === null ? '—' : e.interventionScore.toFixed(2),
    e.hasSummary ? 'yes' : 'no',
  )).join('');
  const pager = next
    ? `<p class="pager"><a href="${h(env.basePath)}/episodes?before=${next.lastActivityAtMs}&amp;id=${h(next.id)}">Older episodes →</a></p>`
    : '';
  const html = layout({
    title: 'Episodes',
    current: 'episodes',
    basePath: env.basePath,
    body: `
<h2>Episodes</h2>
<p class="note">Newest activity first, ${INSPECTOR_PAGE_SIZE} per page. Episodes in channels outside the grant are absent.</p>
<table>
${trHead('Id', 'Channel', 'Status', 'Last activity', 'Human msgs', 'Score', 'Summary')}
${body || tr('<span class="note">No episodes visible.</span>')}
</table>
${pager}
`,
  });
  return { html, status: 200 };
}

function pageEpisodeDetail(route: Extract<InspectorRoute, { name: 'episode' }>, env: PageEnv): RenderedPage {
  const data = episodeDetailPage(env.db, env.grant, route.id, route.after);
  if (!data) return { html: notFoundPage(env.basePath, `Episode ${route.id}`), status: 404 };
  const e = data.episode;
  const details = `<dl class="details">
${kvRow('Id', `<code>${h(e.id)}</code>`)}
${kvRow('Channel', h(`#${e.channelName}`) + ' <code>' + h(e.channelId) + '</code>')}
${kvRow('Status', statusBadge(e.status))}
${kvRow('Started', fmtMs(e.startedAtMs))}
${kvRow('Last activity', fmtMs(e.lastActivityAtMs))}
${kvRow('Ended', fmtMs(e.endedAtMs))}
${kvRow('Messages (human / total)', `${fmtNum(e.humanMessageCount)} / ${fmtNum(e.totalMessageCount)}`)}
${kvRow('Trigger', h(e.triggerReason ?? '—'))}
${kvRow('Consequential', e.consequential === null ? '—' : e.consequential ? 'yes' : 'no')}
${kvRow('Intervention score', e.interventionScore === null ? '—' : e.interventionScore.toFixed(3))}
${kvRow('Reviewed', fmtMs(e.reviewedAtMs))}
</dl>`;
  const summary = e.summary
    ? `<h2>Summary</h2>\n<blockquote class="evidence">${h(e.summary)}</blockquote>`
    : '';
  const runsTable = data.runs.length > 0
    ? `<table>${trHead('Run', 'Type', 'Status', 'Started')}${data.runs.map((r) => tr(
        link(`${env.basePath}/runs/${h(r.id)}`, short(r.id)),
        h(r.runType ?? '—'),
        statusBadge(r.status ?? '—'),
        fmtMs(r.startedAtMs),
      )).join('')}</table>`
    : '';
  const messages = data.messages.length > 0
    ? data.messages.map((m) => `<blockquote class="evidence"><strong>#${m.ordinal}</strong> · ${h(m.authorDisplayName)} · ${fmtMs(m.createdAtMs)}${m.link ? ` · <a href="${h(m.link)}" rel="noreferrer">Discord</a>` : ''}<br>${h(m.content)}</blockquote>`).join('\n')
    : '<p class="note">No permitted messages on this page of the episode.</p>';
  const messagePager = data.messageNextOrdinal !== null
    ? `<p class="pager"><a href="${h(env.basePath)}/episodes/${h(e.id)}?after=${data.messageNextOrdinal}">Later messages →</a></p>`
    : '';
  const html = layout({
    title: `Episode ${short(e.id)}`,
    current: 'episodes',
    basePath: env.basePath,
    body: `
<h2>Episode ${h(short(e.id))}</h2>
${details}
${summary}
<h2>Runs</h2>
${runsTable || '<p class="note">No runs for this episode.</p>'}
<h2>Messages (${data.messages.length} shown of ${fmtNum(e.totalMessageCount ?? data.messages.length)}, ${INSPECTOR_PAGE_SIZE} per page)</h2>
${messages}
${messagePager}
`,
  });
  return { html, status: 200 };
}

// ---- Runs ---------------------------------------------------------------------------

function runUsageCell(run: RunListRow): string {
  const combined = `${fmtNum(run.inputTokens)} / ${fmtNum(run.outputTokens)}`;
  if (run.uncachedInputTokens === null) {
    return `${combined}<br><span class="note">breakdown not recorded</span>`;
  }
  return `${combined}<br><span class="note">${fmtNum(run.uncachedInputTokens)} uncached · ${fmtNum(run.cacheReadTokens)} read · ${fmtNum(run.cacheWriteTokens)} write${run.reasoningTokens === null ? '' : ` · ${fmtNum(run.reasoningTokens)} reasoning`}</span>`;
}

function pageRuns(route: Extract<InspectorRoute, { name: 'runs' }>, env: PageEnv): RenderedPage {
  const { rows, next } = listRuns(env.db, route.cursor);
  const body = rows.map((r) => tr(
    link(`${env.basePath}/runs/${h(r.id)}`, short(r.id)),
    h(r.shadowOfRunId ? `${r.runType} shadow` : r.runType),
    statusBadge(r.status),
    h(r.model),
    r.episodeId ? link(`${env.basePath}/episodes/${h(r.episodeId)}`, short(r.episodeId)) : '—',
    fmtMs(r.startedAtMs),
    runUsageCell(r),
    fmtUsd(r.costUsd),
    h(excerpt(r.error ?? '', 80) || '—'),
  )).join('');
  const pager = next
    ? `<p class="pager"><a href="${h(env.basePath)}/runs?before=${next.startedAtMs}&amp;id=${h(next.id)}">Older runs →</a></p>`
    : '';
  const html = layout({
    title: 'Runs',
    current: 'runs',
    basePath: env.basePath,
    body: `
<h2>Agent runs</h2>
<p class="note">Newest first, ${INSPECTOR_PAGE_SIZE} per page. Open a run for its context ledger.</p>
<table>
${trHead('Run', 'Type', 'Status', 'Model', 'Episode', 'Started', 'Tokens in/out', 'Cost', 'Error')}
${body || tr('<span class="note">No runs yet.</span>')}
</table>
${pager}
`,
  });
  return { html, status: 200 };
}

function pageRunDetail(route: Extract<InspectorRoute, { name: 'run' }>, env: PageEnv): RenderedPage {
  const data = runDetailPage(env.db, env.grant, route.id);
  if (!data) return { html: notFoundPage(env.basePath, `Run ${route.id}`), status: 404 };
  const r = data.run;

  const toolCalls = parseToolCalls(data.toolCallsJson);
  const provenance = parseProvenance(data.provenanceJson);
  const ledger = buildLedger(toolCalls, provenance);
  const svg = renderLedgerSvg(ledger);
  const modelTurns = parseModelTurns(data.modelTurnsJson);
  const traceRows = buildTraceRows(
    modelTurns,
    toolCalls,
    r.executionStartedAtMs ?? r.startedAtMs,
    r.endedAtMs,
  );
  const focusedCall = route.toolCallId === null
    ? null
    : toolCalls.find((call) => call.toolCallId === route.toolCallId && call.exposure !== null);
  const focused = focusedCall?.exposure
    ? focusedExposurePage(env.db, env.grant, focusedCall.exposure, route.exposureAfter ?? 0)
    : null;

  const legend = ledger.segments.map((seg) => {
    const pct = ledger.budget > 0 ? ` (${((seg.chars / ledger.budget) * 100).toFixed(1)}%)` : '';
    const label = seg.toolCallId
      ? link(`${env.basePath}/runs/${h(r.id)}?toolCall=${encodeURIComponent(seg.toolCallId)}#tool-exposure`, seg.label)
      : h(seg.label);
    return `<li><span class="swatch" style="background:${TONES[seg.toneIndex % TONES.length]}"></span>${label} — ${fmtNum(seg.chars)} chars${pct}</li>`;
  }).join('');
  const used = ledger.overflow
    ? ledger.segments.reduce((sum, s) => sum + s.chars, 0)
    : ledger.budget - ledger.free;
  const hasUsageBreakdown = r.uncachedInputTokens !== null;
  const usageBreakdown = hasUsageBreakdown
    ? `${fmtNum(r.uncachedInputTokens)} uncached input · ${fmtNum(r.cacheReadTokens)} cache read · ${fmtNum(r.cacheWriteTokens)} cache write · ${r.cacheWrite1hTokens === null ? '1h cache write not reported' : `${fmtNum(r.cacheWrite1hTokens)} 1h cache write`} · ${r.reasoningTokens === null ? 'reasoning not reported' : `${fmtNum(r.reasoningTokens)} reasoning`} · ${fmtNum(r.providerTotalTokens)} provider total`
    : 'breakdown not recorded';
  const costBreakdown = hasUsageBreakdown
    ? `${fmtUsd(r.uncachedInputCostUsd)} uncached input · ${fmtUsd(r.outputCostUsd)} output · ${fmtUsd(r.cacheReadCostUsd)} cache read · ${fmtUsd(r.cacheWriteCostUsd)} cache write`
    : 'breakdown not recorded';

  const details = `<dl class="details">
${kvRow('Id', `<code>${h(r.id)}</code>`)}
${kvRow('Type', h(r.runType))}
${kvRow('Evaluation role', r.shadowOfRunId ? 'Non-acting shadow' : 'Authoritative')}
${kvRow('Paired run', r.shadowOfRunId
    ? link(`${env.basePath}/runs/${h(r.shadowOfRunId)}`, `authoritative ${short(r.shadowOfRunId)}`)
    : data.pairedShadowRunId
      ? link(`${env.basePath}/runs/${h(data.pairedShadowRunId)}`, `shadow ${short(data.pairedShadowRunId)}`)
      : '—')}
${kvRow('Status', statusBadge(r.status))}
${kvRow('Model', `${h(r.provider)} · ${h(r.model)}`)}
${kvRow('Prompt version', h(r.promptVersion))}
${kvRow('Episode', r.episodeId ? link(`${env.basePath}/episodes/${h(r.episodeId)}`, short(r.episodeId)) : '—')}
${kvRow('Semantic now', fmtMs(r.startedAtMs))}
${kvRow('Execution started / ended', r.executionStartedAtMs === null
    ? 'not recorded (legacy run)'
    : `${fmtMs(r.executionStartedAtMs)} → ${fmtMs(r.endedAtMs)}`)}
${kvRow('Execution duration', r.executionStartedAtMs === null || r.endedAtMs === null
    ? 'not recorded'
    : `${fmtNum(Math.max(0, r.endedAtMs - r.executionStartedAtMs))} ms`)}
${kvRow('Tokens in / out', `${fmtNum(r.inputTokens)} / ${fmtNum(r.outputTokens)}`)}
${kvRow('Token breakdown', usageBreakdown)}
${kvRow('Requested thinking level', h(r.thinkingLevel ?? 'not recorded'))}
${kvRow('Cost breakdown', costBreakdown)}
${kvRow('Cost', fmtUsd(r.costUsd))}
${kvRow('Failure', h(r.error ?? '—'))}
</dl>`;

  const shadowComparison = r.shadowComparison;
  const comparisonObject = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  const authoritativeComparison = comparisonObject(shadowComparison?.authoritative);
  const candidateComparison = comparisonObject(shadowComparison?.shadow);
  const comparisonBlock = shadowComparison
    ? `<h2>Shadow comparison</h2><table>${trHead(
      'Measure',
      'Authoritative medium',
      `Shadow ${r.thinkingLevel ?? 'unknown'}`,
    )}
${tr('Category', h(authoritativeComparison.category ?? '—'), h(candidateComparison.category ?? '—'))}
${tr('Consequential', h(authoritativeComparison.consequential ?? '—'), h(candidateComparison.consequential ?? '—'))}
${tr('Memory count', h(authoritativeComparison.memoryCount ?? '—'), h(candidateComparison.memoryCount ?? '—'))}
${tr('Memory types', h(Array.isArray(authoritativeComparison.memoryTypes) ? authoritativeComparison.memoryTypes.join(', ') : '—'), h(Array.isArray(candidateComparison.memoryTypes) ? candidateComparison.memoryTypes.join(', ') : '—'))}
${tr('Intervention recommended', h(authoritativeComparison.interventionRecommended ?? '—'), h(candidateComparison.interventionRecommended ?? '—'))}
${tr('Category agreement', h(shadowComparison.categoryMatch ?? '—'), '')}
</table>`
    : '';

  const provenanceLine = provenance.charsExposed === null
    ? 'No retrieval provenance recorded.'
    : `${fmtNum(provenance.charsExposed)} chars exposed of a ${fmtNum(provenance.charBudget ?? 60_000)} char budget · ${fmtNum(provenance.channelCount)} channels · ${fmtNum(provenance.messageCount)} messages · ${fmtNum(provenance.memoryCount)} memories${provenance.hasSnapshot ? ' · activity snapshot' : ''}`;

  const toolTable = toolCalls.length > 0
    ? `<table>${trHead('Tool', 'Accepted', 'Error', 'Args chars', 'Result chars')}${toolCalls.map((t) => tr(
        t.exposure ? link(`${env.basePath}/runs/${h(r.id)}?toolCall=${encodeURIComponent(t.toolCallId)}#tool-exposure`, t.toolName) : h(t.toolName),
        t.accepted ? 'yes' : badge('blocked', 'bad'),
        t.isError ? 'yes' : 'no',
        fmtNum(t.argsChars),
        fmtNum(t.resultChars),
      )).join('')}</table>`
    : '<p class="note">No tool calls recorded.</p>';

  const trace = traceRows.length > 0
    ? `<div class="trace">${traceRows.map((row) => {
        const width = Math.max(row.widthPct, row.durationMs > 0 ? 0.35 : 0);
        const label = row.kind === 'tool' && row.tool?.exposure
          ? link(`${env.basePath}/runs/${h(r.id)}?toolCall=${encodeURIComponent(row.tool.toolCallId)}#tool-exposure`, row.label)
          : h(row.label);
        const detail = row.kind === 'model' && row.turn
          ? `${fmtNum(row.durationMs)} ms model · ${fmtNum(row.turn.durationMs)} ms total · ${fmtNum(row.turn.inputTokens)}/${fmtNum(row.turn.outputTokens)} tokens · ${row.turn.version === 1 ? 'breakdown not recorded' : `${fmtNum(row.turn.uncachedInputTokens)} uncached · ${fmtNum(row.turn.cacheReadTokens)} read · ${fmtNum(row.turn.cacheWriteTokens)} write${row.turn.reasoningTokens === null ? '' : ` · ${fmtNum(row.turn.reasoningTokens)} reasoning`}`} · ${fmtUsd(row.turn.costUsd)}${row.turn.stopReason ? ` · ${h(row.turn.stopReason)}` : ''}${row.turn.incomplete ? ' · incomplete' : ''}`
          : `${fmtNum(row.durationMs)} ms · ${h(row.tool?.execution ?? 'unknown')}`;
        return `<div class="trace-row trace-${row.kind}"><div class="trace-label">${label}</div><div class="trace-track"><span style="left:${row.startPct.toFixed(2)}%;width:${width.toFixed(2)}%"></span></div><div class="trace-detail">${detail}</div></div>`;
      }).join('')}</div>`
    : '<p class="note">Timing was not recorded for this run.</p>';

  const exposureBlock = route.toolCallId === null ? '' : focusedCall && focused
    ? `<h2 id="tool-exposure">Tool exposure: ${h(focusedCall.toolName)}</h2>
<p class="note">Current grant-permitted content associated with this call. Exact historical tool output was not retained. ${link(`${env.basePath}/runs/${h(r.id)}#tool-exposure`, 'Clear filter')}</p>
${focused.rows.map((row) => `<article class="exposure"><p><strong>${h(row.kind)}</strong> <code>${h(row.id)}</code> · ${h(row.fingerprintStatus === 'unchanged' ? 'current content matches the exposure version' : row.fingerprintStatus === 'changed' ? 'content changed; only the current version is available' : 'exact historic content was not retained')}</p><p>${h(row.secondary)}${row.atMs === null ? '' : ` · ${fmtMs(row.atMs)}`}</p><blockquote class="evidence">${h(row.content)}</blockquote>${row.link ? `<p>${link(row.link, 'Open in Discord')}</p>` : ''}</article>`).join('') || '<p class="note">No currently visible rows on this page.</p>'}
${focused.unavailableCount ? `<p class="note">${fmtNum(focused.unavailableCount)} item(s) unavailable or no longer visible.</p>` : ''}
${focused.nextOffset === null ? '' : `<p class="pager">${link(`${env.basePath}/runs/${h(r.id)}?toolCall=${encodeURIComponent(focusedCall.toolCallId)}&exposureAfter=${focused.nextOffset}#tool-exposure`, 'Next exposure page →')}</p>`}`
    : `<h2 id="tool-exposure">Tool exposure</h2><p class="note">Tool call is not available. ${link(`${env.basePath}/runs/${h(r.id)}`, 'Clear filter')}</p>`;

  const proposalBlock = r.proposal
    ? `${r.shadowOfRunId ? '<p class="note">Non-acting shadow output — never applied, queued, or sent.</p>' : ''}<dl class="details">
${kvRow('Episode summary', h(r.proposal.episodeSummary ?? '—'))}
${kvRow('Consequential', r.proposal.consequential === null ? '—' : h(r.proposal.consequential))}
${kvRow('Reason', h(r.proposal.reason ?? '—'))}
${kvRow('State', r.proposal.status ? statusBadge(r.proposal.status) : '—')}
${kvRow('Model-proposed outbound text', r.proposal.message ? `<details><summary>Model-proposed outbound text</summary>${r.proposal.status === 'observed' ? '<p class="note">Rejected/observed — never queued or sent.</p>' : ''}<blockquote class="evidence">${h(r.proposal.message)}</blockquote></details>` : '—')}
${kvRow('Score', r.proposal.score === null ? '—' : r.proposal.score.toFixed(3))}
${kvRow('Target channel', r.proposal.targetChannelId ? `<code>${h(r.proposal.targetChannelId)}</code>` : '—')}
</dl>${r.proposal.memoryProposals.length === 0 ? '<p class="note">No memory proposals.</p>' : `<table>${trHead('Action / type', 'Statement', 'Confidence / importance', 'Durability', 'Evidence IDs')}${r.proposal.memoryProposals.map((memory) => tr(
  h(`${memory.action ?? '—'} / ${memory.type ?? '—'}`),
  h(memory.statement ?? '—'),
  `${fmtPct(memory.confidence)} / ${fmtPct(memory.importance)}`,
  h(memory.durability ?? '—'),
  h(memory.evidenceMessageIds.join(', ') || '—'),
)).join('')}</table>`}${renderPolicyDecision(r.proposal.policyDecision)}`
    : '<p class="note">No final proposal.</p>';

  const speechTable = data.speech.length > 0
    ? `<table>${trHead('Kind', 'Id', 'Status', 'At', 'Text')}${data.speech.map((sEntry) => tr(
        h(sEntry.kind),
        `<code>${h(short(sEntry.id))}</code>`,
        statusBadge(sEntry.status),
        fmtMs(sEntry.atMs),
        speechExcerpt(sEntry.text, 200) || '—',
      )).join('')}</table>`
    : '<p class="note">Nothing proposed or delivered from this run.</p>';

  const html = layout({
    title: `Run ${short(r.id)}`,
    current: 'runs',
    basePath: env.basePath,
    body: `
<h2>Run ${h(short(r.id))}</h2>
${details}
${comparisonBlock}
<h2>Context ledger</h2>
<p class="note">Character allocation against the run budget. The unit is characters — the unit the host budgets. Tool arguments and results appear as counts only, never text.</p>
${svg}
<ul class="legend">
${legend || '<li>No allocation recorded.</li>'}
</ul>
<p class="note">${fmtNum(used)} chars used · ${fmtNum(ledger.free)} free${ledger.overflow ? badge('exceeded budget', 'bad') : ''} · ${provenanceLine}</p>
<h2>Execution trace</h2>
<p class="note">Tool indentation means emitted in this turn; it does not imply a tool-to-tool dependency.</p>
${trace}
${exposureBlock}
<h2>Tool calls (${toolCalls.length})</h2>
${toolTable}
<h2>Final proposal</h2>
${proposalBlock}
<h2>Speech trail</h2>
${speechTable}
`,
  });
  return { html, status: 200 };
}

function renderPolicyDecision(value: Record<string, unknown> | null): string {
  if (!value) return '<p class="note">Policy decision details were not recorded for this proposal.</p>';
  const object = (candidate: unknown): Record<string, unknown> => candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? candidate as Record<string, unknown> : {};
  const thresholds = object(value.thresholds), eligibility = object(value.eligibility);
  const safety = object(value.outboundSafety), provenance = object(value.provenanceGate);
  const evidence = object(value.outboundEvidence), subjects = object(value.subjectValidation);
  const attention = object(value.attention);
  const attentionText = [
    attention.required === true || attention.pinned === true ? 'gated' : 'not required',
    typeof attention.mode === 'string' && attention.mode.length > 0 ? `mode ${attention.mode}` : '',
    typeof attention.reason === 'string' ? `reason ${attention.reason}` : '',
    typeof attention.revisionId === 'string' ? `revision ${attention.revisionId.slice(0, 12)}` : '',
    Number.isFinite(attention.windowUntilMs) && Number(attention.windowUntilMs) > 0
      ? `window ends ${new Date(Number(attention.windowUntilMs)).toISOString()}`
      : '',
  ].filter((part) => part.length > 0).join(', ');
  const reasonText = (candidate: unknown): string => Array.isArray(candidate)
    ? candidate.slice(0, 32).filter((item): item is string => typeof item === 'string').map((item) => item.slice(0, 300)).join('; ')
    : '—';
  return `<h3>Host policy decision</h3><table>${trHead('Check', 'Actual', 'Threshold / outcome')}
${tr('Final state', h(value.state ?? '—'), h(value.mode ?? '—'))}
${tr('Intervention score', h(value.score ?? '—'), h(thresholds.score ?? '—'))}
${tr('Confidence', h(eligibility.confidence ?? '—'), h(thresholds.confidence ?? '—'))}
${tr('Evidence strength', h(eligibility.evidenceStrength ?? '—'), h(thresholds.evidenceStrength ?? '—'))}
${tr('Outbound message safety', h(safety.outcome ?? '—'), h(reasonText(safety.reasons)))}
${tr('Retrieval provenance', h(provenance.outcome ?? '—'), h(reasonText(provenance.reasons)))}
${tr('Outbound evidence', h(evidence.outcome ?? '—'), h(reasonText(evidence.reasons)))}
${tr('Scheduled subjects', h(subjects.valid ?? '—'), h(reasonText(subjects.blockingReasons)))}
${tr('Proactive attention', h(attention.eligible === false ? 'suppressed' : 'admitted'), h(attentionText || '—'))}
</table>`;
}

// ---- Speech --------------------------------------------------------------------------

function pageSpeech(route: Extract<InspectorRoute, { name: 'speech' }>, env: PageEnv): RenderedPage {
  const data = speechPage(env.db, route.view, route.cursor);
  const proposalRows = data.proposals.map((p) => tr(
    `<code>${h(short(p.id))}</code>`,
    link(`${env.basePath}/runs/${h(p.runId)}`, short(p.runId)),
    statusBadge(p.status),
    h(`#${p.targetChannelName}`),
    h(excerpt(p.reason, 140)),
    speechExcerpt(p.message, 140) || '—',
    p.score === null ? '—' : p.score.toFixed(2),
    fmtMs(p.createdAtMs),
    p.reviewedByUserId ? `<code>${h(short(p.reviewedByUserId))}</code> ${fmtMs(p.reviewedAtMs)}` : '—',
  )).join('');
  const deliveryRows = data.deliveries.map((d) => tr(
    `<code>${h(short(d.id))}</code>`,
    statusBadge(d.status),
    h(`#${d.channelName}`),
    speechExcerpt(d.content, 200),
    fmtNum(d.attempts),
    h(excerpt(d.lastError ?? '', 100) || '—'),
    fmtMs(d.createdAtMs),
    fmtMs(d.sentAtMs),
  )).join('');
  const isDeliveries = data.view === 'deliveries';
  const tabs = `<p class="pager">
    ${isDeliveries ? link(`${env.basePath}/speech`, 'Proposals') : '<strong>Proposals</strong>'}
    ·
    ${isDeliveries ? '<strong>Deliveries</strong>' : link(`${env.basePath}/speech?view=deliveries`, 'Deliveries')}
  </p>`;
  const nextQuery = data.next
    ? new URLSearchParams({
        ...(isDeliveries ? { view: 'deliveries' } : {}),
        before: String(data.next.createdAtMs),
        id: data.next.id,
      }).toString()
    : null;
  const pager = [
    route.cursor ? `<a href="${h(env.basePath)}/speech${isDeliveries ? '?view=deliveries' : ''}">← First page</a>` : '',
    nextQuery ? `<a href="${h(env.basePath)}/speech?${h(nextQuery)}">Older ${isDeliveries ? 'deliveries' : 'proposals'} →</a>` : '',
  ].filter(Boolean).join(' · ');
  const html = layout({
    title: 'Speech',
    current: 'speech',
    basePath: env.basePath,
    body: `
<h2>Speech</h2>
<p class="note">${fmtNum(data.totalMatching)} ${isDeliveries ? 'deliveries' : 'proposals'}, newest first, ${INSPECTOR_PAGE_SIZE} per page.</p>
${tabs}
${isDeliveries ? `
<table>
${trHead('Id', 'Status', 'Channel', 'Content', 'Attempts', 'Last error', 'Created', 'Sent')}
${deliveryRows || tr('<span class="note">No deliveries.</span>')}
</table>` : `
<table>
${trHead('Id', 'Run', 'Status', 'Channel', 'Reason', 'Message', 'Score', 'Created', 'Review')}
${proposalRows || tr('<span class="note">No proposals.</span>')}
</table>`}
${pager ? `<p class="pager">${pager}</p>` : ''}
`,
  });
  return { html, status: 200 };
}

// ---- Channels -------------------------------------------------------------------------

function pageChannels(route: Extract<InspectorRoute, { name: 'channels' }>, env: PageEnv): RenderedPage {
  const page = channelsPage(env.db, route.view, route.cursor);
  const isThreads = page.view === 'threads';
  const body = page.rows.map((c) => tr(
    `<code>${h(short(c.id))}</code>`,
    h(isThreads ? c.name : `#${c.name}`),
    isThreads
      ? h(c.parentName ? `#${c.parentName}` : c.parentId ?? '—')
      : fmtNum(c.threadCount),
    c.visibilityClass === 'org' ? badge('org', 'scope')
      : c.visibilityClass === 'restricted' ? badge('restricted', 'warn')
      : c.visibilityClass === 'review_only' ? badge('review-only', 'bad')
      : badge('excluded', 'neutral'),
    c.ingestEnabled ? 'on' : badge('paused', 'warn'),
    c.deletedAtMs !== null ? badge(`deleted ${fmtMs(c.deletedAtMs)}`, 'bad') : 'live',
    fmtNum(c.messageCount),
    fmtNum(c.episodeCount),
    c.controlSurface ? 'not ingested (control surface)' : fmtMs(c.lastMessageAtMs),
  )).join('');
  const next = page.next;
  const query = next
    ? new URLSearchParams({
        ...(isThreads ? { view: 'threads' } : {}),
        afterDeleted: String(next.deleted),
        afterName: next.sortName,
        afterId: next.id,
      }).toString()
    : null;
  const pager = [
    route.cursor ? `<a href="${h(env.basePath)}/channels${isThreads ? '?view=threads' : ''}">← First page</a>` : '',
    next ? `<a href="${h(env.basePath)}/channels?${h(query)}">Next page →</a>` : '',
  ].filter(Boolean).join(' · ');
  const tabs = `<p class="pager">
    ${isThreads ? link(`${env.basePath}/channels`, `Channels`) : '<strong>Channels</strong>'}
    ·
    ${isThreads ? '<strong>Threads</strong>' : link(`${env.basePath}/channels?view=threads`, `Threads`)}
  </p>`;
  const html = layout({
    title: 'Channels',
    current: 'channels',
    basePath: env.basePath,
    body: `
<h2>Channels</h2>
<p class="note">Policy view: ${fmtNum(page.totalMatching)} ${isThreads ? 'threads' : 'channels'}, sorted by name with live rows first. ${INSPECTOR_PAGE_SIZE} per page. No message content on this page.</p>
${tabs}
<table>
${trHead('Id', isThreads ? 'Thread' : 'Channel', isThreads ? 'Parent channel' : 'Threads', 'Visibility', 'Ingest', 'State', 'Messages', 'Episodes', 'Last message')}
${body || tr(`<span class="note">No ${isThreads ? 'threads' : 'channels'} discovered.</span>`)}
</table>
${pager ? `<p class="pager">${pager}</p>` : ''}
`,
  });
  return { html, status: 200 };
}

// ---- Jobs --------------------------------------------------------------------------------

function pageJobs(route: Extract<InspectorRoute, { name: 'jobs' }>, env: PageEnv): RenderedPage {
  const { rows, counts, totalMatching, next } = jobsPage(env.db, route);
  const countsLine = Object.entries(counts).map(([k, v]) => `${h(k)} ${fmtNum(v)}`).join(' · ') || 'empty';
  const body = rows.map((j) => tr(
    `<code>${h(short(j.id))}</code>`,
    h(j.type),
    statusBadge(j.status),
    fmtNum(j.priority),
    `${fmtNum(j.attempts)} / ${fmtNum(j.maxAttempts)}`,
    fmtMs(j.runAfterMs),
    h(excerpt(j.lastError ?? '', 120) || '—'),
    fmtMs(j.createdAtMs),
  )).join('');
  const statusOptions = ['<option value="">any status</option>', ...Object.keys(counts).sort().map((status) =>
    `<option value="${h(status)}"${route.status === status ? ' selected' : ''}>${h(status)}</option>`)].join('');
  const form = `<form class="get" method="get" action="${h(env.basePath)}/jobs">
    <input type="search" name="type" value="${h(route.type ?? '')}" placeholder="Exact job type" maxlength="64" size="24">
    <select name="status">${statusOptions}</select>
    <button type="submit">Apply</button>
  </form>`;
  const filters = {
    ...(route.type ? { type: route.type } : {}),
    ...(route.status ? { status: route.status } : {}),
  };
  const firstQuery = new URLSearchParams(filters).toString();
  const nextQuery = next ? new URLSearchParams({
    ...filters,
    before: String(next.createdAtMs),
    id: next.id,
  }).toString() : null;
  const pager = [
    route.cursor ? `<a href="${h(env.basePath)}/jobs${firstQuery ? `?${h(firstQuery)}` : ''}">← First page</a>` : '',
    nextQuery ? `<a href="${h(env.basePath)}/jobs?${h(nextQuery)}">Older jobs →</a>` : '',
  ].filter(Boolean).join(' · ');
  const html = layout({
    title: 'Jobs',
    current: 'jobs',
    basePath: env.basePath,
    body: `
<h2>Durable jobs</h2>
<p class="note">Queue: ${countsLine} · ${fmtNum(totalMatching)} matching jobs · ${INSPECTOR_PAGE_SIZE} per page.</p>
${form}
<table>
${trHead('Id', 'Type', 'Status', 'Priority', 'Attempts', 'Run after', 'Last error', 'Created')}
${body || tr('<span class="note">No jobs.</span>')}
</table>
${pager ? `<p class="pager">${pager}</p>` : ''}
`,
  });
  return { html, status: 200 };
}

// ---- Audit -----------------------------------------------------------------------------

function pageAudit(route: Extract<InspectorRoute, { name: 'audit' }>, env: PageEnv): RenderedPage {
  const { rows, next, totalMatching } = auditPage(env.db, route.cursor);
  const body = rows.map((a) => tr(
    `<code>${h(short(a.id))}</code>`,
    fmtMs(a.createdAtMs),
    `<code>${h(short(a.actorUserId))}</code>`,
    h(a.action),
    h(a.target ?? '—'),
    h(excerpt(a.details ?? '', 160) || '—'),
  )).join('');
  const pager = [
    route.cursor ? `<a href="${h(env.basePath)}/audit">← First page</a>` : '',
    next ? `<a href="${h(env.basePath)}/audit?before=${next.createdAtMs}&amp;id=${h(next.id)}">Older events →</a>` : '',
  ].filter(Boolean).join(' · ');
  const html = layout({
    title: 'Audit',
    current: 'audit',
    basePath: env.basePath,
    body: `
<h2>Admin events</h2>
<p class="note">${fmtNum(totalMatching)} audited admin actions, newest first, ${INSPECTOR_PAGE_SIZE} per page. Details were sanitized at write time.</p>
<table>
${trHead('Id', 'At', 'Actor', 'Action', 'Target', 'Details')}
${body || tr('<span class="note">No admin events.</span>')}
</table>
${pager ? `<p class="pager">${pager}</p>` : ''}
`,
  });
  return { html, status: 200 };
}

// ---- Resolve ------------------------------------------------------------------------------

function pageResolve(route: Extract<InspectorRoute, { name: 'resolve' }>, env: PageEnv): RenderedPage {
  const resolved = resolveEntity(env.db, env.grant, route.id);
  const form = `
<form class="get" method="get" action="${h(env.basePath)}/resolve">
  <input type="search" name="id" value="${h(route.id)}" placeholder="Paste any id or unique prefix (8+ chars)" maxlength="128" size="40">
  <button type="submit">Resolve</button>
</form>`;
  let result: string;
  if (!resolved) {
    result = `<p class="note">Nothing matches ${h(route.id)}: the id is unknown, ambiguous, or hidden under the grant.</p>`;
  } else {
    const target = targetFor(resolved, env.basePath);
    result = target === null
      ? describeExternal(resolved)
      : `<p>${h(kindLabel(resolved))} <code>${h(resolved.id)}</code> → ${link(target, target)}</p>`;
  }
  const html = layout({
    title: 'Resolve',
    basePath: env.basePath,
    body: `
<h2>Resolve an id</h2>
${form}
${result}
`,
  });
  return { html, status: 200 };
}

/** A non-null resolved entity, for the label/target/describe helpers below. */
type Resolved = NonNullable<ReturnType<typeof resolveEntity>>;

function kindLabel(resolved: Resolved): string {
  switch (resolved.kind) {
    case 'memory': return 'Memory';
    case 'episode': return 'Episode';
    case 'run': return 'Run';
    case 'proposal': return 'Proposal';
    case 'outbox': return 'Outbox delivery';
    case 'job': return 'Job';
    case 'admin_event': return 'Admin event';
    case 'channel': return 'Channel';
    case 'message': return 'Message';
  }
}

/** Internal page for resolvable kinds; null when the target has no page. */
function targetFor(resolved: Resolved, basePath: string): string | null {
  switch (resolved.kind) {
    case 'memory': return `${basePath}/memories/${resolved.id}`;
    case 'episode': return `${basePath}/episodes/${resolved.id}`;
    case 'run': return `${basePath}/runs/${resolved.id}`;
    case 'proposal':
    case 'outbox': return `${basePath}/speech`;
    case 'job': return `${basePath}/jobs`;
    case 'admin_event': return `${basePath}/audit`;
    case 'channel': return `${basePath}/channels`;
    case 'message': return null;
  }
}

/** Kinds without their own page get a sentence instead of a link. */
function describeExternal(resolved: Resolved): string {
  if (resolved.kind === 'message') {
    const jump = resolved.guildId && resolved.channelId
      ? ` <a href="${h(messageLink(resolved.guildId, resolved.channelId, resolved.id))}" rel="noreferrer">Open on Discord</a>`
      : '';
    return `<p>Message <code>${h(resolved.id)}</code> in channel <code>${h(resolved.channelId ?? '—')}</code>.${jump}</p>`;
  }
  return `<p>${h(kindLabel(resolved))} <code>${h(resolved.id)}</code>.</p>`;
}

/**
 * Short identifier for display; full ids stay available in links and detail
 * pages. Does not escape — callers wrap the result in `h()` or `link()`.
 */
function short(id: string | null | undefined, len = 8): string {
  if (!id) return '—';
  return id.length <= len ? id : id.slice(0, len);
}
