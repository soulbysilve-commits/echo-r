// Weekly long-form marketing operator entrypoint (DEV.to / Qiita only).
// Genuinely separate from the daily operator (operator.mjs) — never
// imported by it, never imports it — but reuses every real primitive the
// daily operator's own devto/qiita cycles already use: lib/
// factPromotion.mjs's loadCanonicalFacts(), lib/scoring.mjs's rankFacts(),
// lib/channelPolicy.mjs's AUTO_PUBLIC gate, lib/lock.mjs's single-slot
// operator_lock (the SAME lock row the daily operator uses — a weekly and
// a daily run must never write to the same channel's ledger/frequency
// state concurrently), and lib/weeklyLongForm.mjs's selection/draft/
// publish pipeline (itself built entirely from the daily operator's own
// shared gate primitives — see that module's doc comment).
import { randomUUID } from 'node:crypto';
import { openDb, closeDb } from './lib/db.mjs';
import { acquireLock, releaseLock } from './lib/lock.mjs';
import { loadCanonicalFacts } from './lib/factPromotion.mjs';
import { rankFacts } from './lib/scoring.mjs';
import { channelPolicy, MODE } from './lib/channelPolicy.mjs';
import { statePath } from './lib/paths.mjs';
import {
  selectWeeklyFactSet, draftWeeklyDevToArticle, draftWeeklyQiitaArticle, publishWeeklyLongForm,
} from './lib/weeklyLongForm.mjs';

export const DB_PATH = process.env.MARKETING_DB_PATH || statePath('marketing.db');
export const FACTS_PATH = new URL('../../docs/marketing/VERITAS_FORGE_PUBLIC_FACTS.md', import.meta.url).pathname;

/**
 * Channel-scoped, PUBLISHED-only check — identical convention to
 * operator.mjs's own alreadyPublishedByChannel() (deliberately not
 * exported/shared across the two files' otherwise-independent module
 * boundaries, same one-line query, no meaningful duplication risk).
 */
function alreadyPublishedByChannel(db, channel, factId) {
  const row = db
    .prepare("SELECT 1 FROM publication_ledger WHERE channel = ? AND source_evidence LIKE '%' || ? || '%' AND published_at IS NOT NULL LIMIT 1")
    .get(channel, factId);
  return !!row;
}

async function runWeeklyChannel(db, channel, draftFn, { factsPath, env, fetchImpl } = {}) {
  if (channelPolicy(channel).mode !== MODE.AUTO_PUBLIC) {
    return { status: 'CHANNEL_NOT_SCHEDULED' };
  }
  let facts;
  try {
    facts = loadCanonicalFacts(factsPath, db);
  } catch {
    return { status: 'NO_FACTS' };
  }
  const ranked = rankFacts(facts);
  const factSet = selectWeeklyFactSet(db, channel, ranked, {
    alreadyPublished: (factId) => alreadyPublishedByChannel(db, channel, factId),
  });
  if (!factSet) {
    return { status: 'NOOP', reason: 'insufficient verified technical material for a coherent weekly article' };
  }
  return publishWeeklyLongForm(db, channel, factSet, draftFn, { env, fetchImpl });
}

/**
 * One full weekly long-form cycle: DEV.to, then Qiita, each independently
 * selecting its own coherent fact set and publishing (or NOOPing) through
 * the shared gate pipeline. Safe to call repeatedly: overlap with another
 * weekly OR daily run is refused via the shared operator_lock, and a
 * genuinely re-run cycle over unchanged DB state re-derives the identical
 * fact set and article text, which the ledger's own content-hash
 * idempotency (lib/ledger.mjs) already treats as the same publication —
 * never a second parallel "weekly run key" mechanism.
 */
export async function runWeeklyLongFormOnce({ dbPath = DB_PATH, factsPath = FACTS_PATH, env = process.env, fetchImpl } = {}) {
  const db = openDb(dbPath);
  const lockRunId = randomUUID();
  const lock = acquireLock(db, lockRunId);
  if (!lock.acquired) {
    closeDb(db);
    return { status: 'SKIP_OVERLAP', holder: lock.holder };
  }
  try {
    const devto = await runWeeklyChannel(db, 'devto', draftWeeklyDevToArticle, { factsPath, env, fetchImpl })
      .catch((err) => ({ status: 'ERROR', message: String(err?.message ?? err) }));
    const qiita = await runWeeklyChannel(db, 'qiita', draftWeeklyQiitaArticle, { factsPath, env, fetchImpl })
      .catch((err) => ({ status: 'ERROR', message: String(err?.message ?? err) }));
    return { devto, qiita };
  } finally {
    releaseLock(db, lockRunId);
    closeDb(db);
  }
}
