import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { analyzePerformance, strategyHistory } from './learning.mjs';
import { listMarketEntries } from './market.mjs';
import { listExperiments } from './experiments.mjs';

function isoWeekAgo() {
  return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
}

export function buildWeeklyReport(db, { now = new Date() } = {}) {
  const since = isoWeekAgo();
  const published = db.prepare('SELECT * FROM publication_ledger WHERE published_at >= ? ORDER BY published_at').all(since);
  const failed = db.prepare("SELECT * FROM publication_ledger WHERE result LIKE 'FAILED%' AND created_at >= ?").all(since);
  const performance = analyzePerformance(db);
  const market = listMarketEntries(db).filter((e) => e.retrieved_at >= since);
  const experiments = listExperiments(db).filter((e) => e.started_at >= since);
  const strategy = strategyHistory(db);

  const channelPerf = performance.channel ?? {};
  const best = Object.entries(channelPerf).filter(([, v]) => v.trusted).sort((a, b) => (b[1].ctr ?? 0) - (a[1].ctr ?? 0))[0];
  const worst = Object.entries(channelPerf).filter(([, v]) => v.trusted).sort((a, b) => (a[1].ctr ?? 0) - (b[1].ctr ?? 0))[0];

  const dateStr = now.toISOString().slice(0, 10);

  const lines = [];
  lines.push(`# Weekly Marketing Report — ${dateStr}`);
  lines.push('');
  lines.push('## Content produced this week');
  if (published.length === 0) {
    lines.push('- None published this week (DRY_RUN mode, no connected channels, or genuinely NO_POST days). See run_log for details.');
  } else {
    for (const row of published) {
      lines.push(`- [${row.channel}] ${row.content_type ?? ''} — published ${row.published_at} — ${row.external_url ?? '(no external URL)'}`);
    }
  }
  lines.push('');
  lines.push('## Failed publications');
  lines.push(failed.length === 0 ? '- None' : failed.map((r) => `- [${r.channel}] ${r.result}`).join('\n'));
  lines.push('');
  lines.push('## Channel performance (trusted groups only, n >= 5)');
  const trustedChannels = Object.entries(channelPerf).filter(([, v]) => v.trusted);
  lines.push(trustedChannels.length === 0
    ? '- Not enough data yet for a trusted performance comparison.'
    : trustedChannels.map(([ch, v]) => `- ${ch}: n=${v.n}, impressions=${v.impressions}, clicks=${v.clicks}, ctr=${v.ctr?.toFixed(3) ?? 'n/a'}, conversions=${v.conversions}`).join('\n'));
  lines.push('');
  lines.push(`## Best content this period: ${best ? best[0] : 'not enough data'}`);
  lines.push(`## Worst content this period: ${worst ? worst[0] : 'not enough data'}`);
  lines.push('');
  lines.push('## Market movement');
  lines.push(market.length === 0 ? '- No new market-watch entries recorded this week.' : market.map((m) => `- [${m.evidence_class}] ${m.claim} (${m.source})`).join('\n'));
  lines.push('');
  lines.push('## Content experiments');
  lines.push(experiments.length === 0 ? '- None running this week.' : experiments.map((e) => `- ${e.experiment_id}: ${e.hypothesis} — ${e.winner ? `winner ${e.winner} (confidence ${e.confidence})` : 'not yet decided'}`).join('\n'));
  lines.push('');
  lines.push('## Strategy decisions to date');
  lines.push(strategy.length === 0 ? '- None yet (no group has both reached minimum sample size and shown a decisive lift).' : strategy.map((s) => `- ${s.version} (${s.created_at}): ${s.reason}`).join('\n'));
  lines.push('');
  lines.push('## Lessons');
  lines.push('- (Populate from the specific week\'s notable results — this generator reports data, not narrative judgment.)');
  lines.push('');
  lines.push('## Next week\'s plan');
  lines.push('- (Set by whoever reviews this report — see docs/marketing/30_DAY_CONTENT_PLAN.md for the rolling default.)');

  return lines.join('\n') + '\n';
}

/**
 * Writes the report to docs/marketing/reports/YYYY-MM-DD_WEEKLY.md.
 * Never overwrites an existing report for the same date — if one exists,
 * returns { written: false } instead of silently clobbering it.
 */
export function writeWeeklyReport(db, reportsDir, { now = new Date() } = {}) {
  const dateStr = now.toISOString().slice(0, 10);
  const path = `${reportsDir}/${dateStr}_WEEKLY.md`;
  if (existsSync(path)) {
    return { written: false, path, reason: 'a report for this date already exists' };
  }
  mkdirSync(dirname(path), { recursive: true });
  const content = buildWeeklyReport(db, { now });
  writeFileSync(path, content);
  return { written: true, path };
}
