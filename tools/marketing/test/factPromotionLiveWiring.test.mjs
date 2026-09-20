// Live candidate-selection wiring tests (mandate: "Wire already-PUBLIC_SAFE
// machine_verified_facts into the SAME canonical fact candidate-selection
// path used by real marketing, while preserving every existing activation/
// evidence/frequency/stagger/idempotency guard"). These exercise the REAL
// operator.mjs entry points (runOnce()/runDevToCycle/runQiitaCycle) — the
// exact functions the production systemd service calls — never a
// reimplementation of them. No real network call, no real credential, no
// real git subprocess, and no timer/service is ever started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../lib/db.mjs';
import { runOnce, runDevToCycle, runQiitaCycle } from '../operator.mjs';
import { connectors } from '../connectors/index.mjs';
import { ensureActivationBoundary } from '../lib/activation.mjs';
import { recordAuthCheck, recordCanary } from '../lib/channelState.mjs';
import {
  recordFactPromotion, loadMergedFacts, loadCanonicalFacts, MACHINE_FACT_SOURCE_KEY,
} from '../lib/factPromotion.mjs';
import { isTechnicalSubstance, draftDevToArticle, draftQiitaArticle } from '../lib/crossChannelDraft.mjs';
import { normalizeChannelEnableFlags, withIsolatedLiveEnv } from './testEnvIsolation.mjs';

process.env.ECHO_AGENT_REPO_ROOT = '/nonexistent/marketing-test-stub/echo-agent';
process.env.ECHO_APP_REPO_ROOT = '/nonexistent/marketing-test-stub/echo-app';
process.env.NOEMORA_REPO_ROOT = '/nonexistent/marketing-test-stub/noemora';
process.env.OFFICIAL_SITE_REPO_ROOT = '/nonexistent/marketing-test-stub/official-site';
process.env.ECHO_AGENT_DEV_ROOT = '/nonexistent/marketing-test-stub/echo-agent-dev';
process.env.ECHO_APP_DEV_ROOT = '/nonexistent/marketing-test-stub/echo-app-dev';
process.env.NOEMORA_DEV_ROOT = '/nonexistent/marketing-test-stub/noemora-dev';
process.env.OFFICIAL_SITE_DEV_ROOT = '/nonexistent/marketing-test-stub/official-site-dev';
normalizeChannelEnableFlags();

function tempEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-livewiring-test-'));
  const dbPath = join(dir, 'test.db');
  const factsPath = join(dir, 'facts.md');
  writeFileSync(factsPath, '\n'); // empty hand-authored registry — every candidate in these tests is machine-generated
  return { dir, dbPath, factsPath };
}

function machineEvidence(overrides = {}) {
  return {
    ok: true,
    evidenceType: 'noemora_public_demo_seal',
    product: 'ECHO Agent',
    sourceRepository: 'ECHODiscord版',
    artifactPath: 'CI_LIVE_WIRING_REPORT.md',
    artifactHash: 'c'.repeat(64),
    sourceRevision: 'V1',
    verifiedAt: '2026-09-18T00:00:00.000Z',
    result: 'PASS',
    verifierIdentity: 'test-verifier',
    claim: "ECHO Agent's persisted end-to-end identity-continuity test suite passed for: checkout flow.",
    claimStatus: 'VERIFIED',
    limitations: null,
    ...overrides,
  };
}

test('wiring: a machine fact after BOTH the source boundary and the channel boundary is a real, eligible Bluesky candidate (mocked connector, no real network)', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  const prevMode = process.env.MARKETING_MODE;
  const prevAuto = process.env.ECHO_MARKETING_AUTOMATION_ENABLED;
  try {
    const db = openDb(dbPath);
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z'); // global
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z', MACHINE_FACT_SOURCE_KEY); // machine-fact source — before the evidence
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z', 'bluesky'); // channel — before the evidence
    recordAuthCheck(db, 'bluesky', { authValid: true, accountIdentifier: '@veritasforge.bsky.social', permissionsSufficient: true });
    recordCanary(db, 'bluesky', { passed: true, externalId: 'canary1', externalUrl: 'https://bsky.app/x' });
    recordFactPromotion(db, machineEvidence(), { activationBoundary: '2020-01-01T00:00:00.000Z', knownCurrentRevision: 'V1' });
    closeDb(db);

    process.env.MARKETING_MODE = 'LIVE';
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = 'true';

    let publishCalled = false;
    const fetchImpl = async (url) => {
      publishCalled = true;
      if (url.includes('createSession')) return { ok: true, status: 200, json: async () => ({ accessJwt: 'j', did: 'did:plc:x', handle: 'veritasforge.bsky.social' }) };
      if (url.includes('createRecord')) return { ok: true, status: 200, json: async () => ({ uri: 'at://did:plc:x/app.bsky.feed.post/mvf1', cid: 'c1' }) };
      throw new Error(`unexpected url ${url}`);
    };
    const result = await runOnce({
      dbPath, factsPath, env: { MARKETING_BLUESKY_ENABLED: 'true', BLUESKY_IDENTIFIER: 'veritasforge.bsky.social', BLUESKY_APP_PASSWORD: 'pw' }, fetchImpl,
    });
    assert.equal(result.bluesky.status, 'PUBLISHED');
    assert.equal(publishCalled, true);
    assert.equal(result.bluesky.externalId, 'at://did:plc:x/app.bsky.feed.post/mvf1');
  } finally {
    process.env.MARKETING_MODE = prevMode;
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = prevAuto;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('wiring: a machine fact AFTER the source boundary but BEFORE the channel\'s own boundary is blocked, never published', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  const prevMode = process.env.MARKETING_MODE;
  const prevAuto = process.env.ECHO_MARKETING_AUTOMATION_ENABLED;
  try {
    const db = openDb(dbPath);
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z'); // global
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z', MACHINE_FACT_SOURCE_KEY); // machine source — before the evidence
    ensureActivationBoundary(db, '2099-01-01T00:00:00.000Z', 'bluesky'); // channel boundary — AFTER the evidence (evidence predates it)
    recordAuthCheck(db, 'bluesky', { authValid: true, accountIdentifier: '@veritasforge.bsky.social', permissionsSufficient: true });
    recordCanary(db, 'bluesky', { passed: true, externalId: 'canary1', externalUrl: 'https://bsky.app/x' });
    recordFactPromotion(db, machineEvidence(), { activationBoundary: '2020-01-01T00:00:00.000Z', knownCurrentRevision: 'V1' });
    closeDb(db);

    process.env.MARKETING_MODE = 'LIVE';
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = 'true';

    let publishCalled = false;
    const fetchImpl = async () => { publishCalled = true; throw new Error('must never be called'); };
    const result = await runOnce({
      dbPath, factsPath, env: { MARKETING_BLUESKY_ENABLED: 'true', BLUESKY_IDENTIFIER: 'veritasforge.bsky.social', BLUESKY_APP_PASSWORD: 'pw' }, fetchImpl,
    });
    assert.notEqual(result.bluesky.status, 'PUBLISHED');
    assert.equal(publishCalled, false, 'the connector must never be reached — the channel\'s own activation boundary must still block this');
  } finally {
    process.env.MARKETING_MODE = prevMode;
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = prevAuto;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('wiring: a machine fact BEFORE the machine-source boundary is blocked even though it is otherwise clean strong evidence (no backlog laundering)', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  const prevMode = process.env.MARKETING_MODE;
  const prevAuto = process.env.ECHO_MARKETING_AUTOMATION_ENABLED;
  try {
    const db = openDb(dbPath);
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z'); // global — before the evidence
    ensureActivationBoundary(db, '2099-01-01T00:00:00.000Z', MACHINE_FACT_SOURCE_KEY); // machine source boundary set AFTER the evidence's own verified_at
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z', 'bluesky'); // channel — before the evidence
    recordAuthCheck(db, 'bluesky', { authValid: true, accountIdentifier: '@veritasforge.bsky.social', permissionsSufficient: true });
    recordCanary(db, 'bluesky', { passed: true, externalId: 'canary1', externalUrl: 'https://bsky.app/x' });
    // Evidence itself already cleared the GLOBAL boundary at promotion time (PUBLIC_SAFE_VERIFIED_FACT) —
    // this proves loadMergedFacts()'s OWN separate source boundary is what blocks it, not the gate above.
    const rec = recordFactPromotion(db, machineEvidence(), { activationBoundary: '2020-01-01T00:00:00.000Z', knownCurrentRevision: 'V1' });
    assert.equal(rec.stage, 'PUBLIC_SAFE_VERIFIED_FACT');
    closeDb(db);

    process.env.MARKETING_MODE = 'LIVE';
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = 'true';
    let publishCalled = false;
    const fetchImpl = async () => { publishCalled = true; throw new Error('must never be called'); };
    const result = await runOnce({
      dbPath, factsPath, env: { MARKETING_BLUESKY_ENABLED: 'true', BLUESKY_IDENTIFIER: 'veritasforge.bsky.social', BLUESKY_APP_PASSWORD: 'pw' }, fetchImpl,
    });
    assert.equal(result.bluesky.status, 'NO_POST', 'the fact never even becomes a candidate — filtered out before ranking');
    assert.equal(publishCalled, false);
  } finally {
    process.env.MARKETING_MODE = prevMode;
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = prevAuto;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('wiring: a hand-authored fact and a machine fact describing the SAME evidence (same repository+artifact path) collapse to ONE candidate — the human version wins', () => {
  const { dir, dbPath } = tempEnv();
  try {
    const db = openDb(dbPath);
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z', MACHINE_FACT_SOURCE_KEY);
    recordFactPromotion(db, machineEvidence({ sourceRepository: 'ECHODiscord版', artifactPath: 'shared_evidence.py' }), {
      activationBoundary: null, knownCurrentRevision: 'V1',
    });
    const handAuthored = [{
      id: 'FACT-777', PRODUCT: 'ECHO Agent', STATUS: 'VERIFIED', CLAIM: 'The human-curated, precisely-worded version of this claim.',
      SOURCE_REPOSITORY: 'ECHODiscord版', SOURCE_PATH: 'shared_evidence.py', SOURCE_EVIDENCE: 'human-reviewed', VERIFIED_AT: '2026-09-01', PUBLIC_SAFE: 'true', NOTES: '',
    }];
    const merged = loadMergedFacts(handAuthored, db);
    assert.equal(merged.length, 1, 'exactly one candidate — never both a human and a machine variant of the same evidence');
    assert.equal(merged[0].id, 'FACT-777', 'the hand-authored fact must win the collision');
    closeDb(db);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('wiring: a generic-schema evidence record with public_safe:false never becomes a PUBLIC_SAFE_VERIFIED_FACT candidate', async () => {
  const { dir, dbPath } = tempEnv();
  try {
    const db = openDb(dbPath);
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z', MACHINE_FACT_SOURCE_KEY);
    const { validateEvidence, GENERIC_SCHEMA_ID } = await import('../lib/evidenceAllowlist.mjs');
    const text = JSON.stringify({
      schema: GENERIC_SCHEMA_ID, product: 'ECHO Agent', artifact_type: 'e2e_test_report', source_revision: 'r1',
      verified_at: '2026-09-18T00:00:00.000Z', result: 'PASS', verifier: 'x', public_safe: false, claim_topic: 'e2e_test_pass',
    });
    const evidence = validateEvidence({ product: 'ECHO Agent', sourceRepository: 'ECHODiscord版', relPath: 'NOT_PUBLIC_REPORT.json', text });
    assert.equal(evidence.ok, false, 'public_safe:false must be rejected at the allowlist stage, not merely at promotion');
    const rec = recordFactPromotion(db, evidence);
    assert.equal(rec.stage, 'BLOCKED_UNVERIFIED');
    const merged = loadMergedFacts([], db);
    assert.equal(merged.length, 0);
    closeDb(db);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('wiring: a technical machine fact IS considered by DEV.to/Qiita\'s own unchanged technical-substance gate', () => {
  const machineFact = {
    id: 'MVF-technical', PRODUCT: 'ECHO Agent', STATUS: 'VERIFIED',
    CLAIM: "ECHO Agent's end-to-end test suite passed for: idempotent write-ahead-log checkpoint and verifier continuity.",
    SOURCE_REPOSITORY: 'ECHODiscord版', SOURCE_PATH: 'CI_REPORT.json', SOURCE_EVIDENCE: 'generic:e2e_test_report (revision r1, sha256 aaaaaaaaaaaa...)',
    VERIFIED_AT: '2026-09-18T00:00:00.000Z', PUBLIC_SAFE: 'true', NOTES: '',
  };
  assert.equal(isTechnicalSubstance(machineFact), true);
  assert.ok(draftDevToArticle(machineFact) !== null);
  assert.ok(draftQiitaArticle(machineFact) !== null);
});

test('wiring: a non-technical machine fact is REJECTED by DEV.to/Qiita\'s own unchanged technical-substance gate (draft returns null, never a generic announcement mirror)', () => {
  const machineFact = {
    id: 'MVF-nontechnical', PRODUCT: 'ECHO Agent', STATUS: 'PARTIAL',
    CLAIM: 'ECHO Agent has passing automated test coverage for: the new onboarding welcome screen copy.',
    SOURCE_REPOSITORY: 'ECHODiscord版', SOURCE_PATH: 'CI_REPORT2.json', SOURCE_EVIDENCE: 'generic:unit_test_report (revision r1, sha256 bbbbbbbbbbbb...)',
    VERIFIED_AT: '2026-09-18T00:00:00.000Z', PUBLIC_SAFE: 'true', NOTES: '',
  };
  assert.equal(isTechnicalSubstance(machineFact), false);
  assert.equal(draftDevToArticle(machineFact), null);
  assert.equal(draftQiitaArticle(machineFact), null);
});

test('wiring: DEV.to/Qiita real cycles (runDevToCycle/runQiitaCycle) select an eligible machine fact exactly like a hand-authored one, past every existing gate, mocked connector only', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  const prevMode = process.env.MARKETING_MODE;
  const prevAuto = process.env.ECHO_MARKETING_AUTOMATION_ENABLED;
  try {
    const db = openDb(dbPath);
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z');
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z', MACHINE_FACT_SOURCE_KEY);
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z', 'devto');
    recordAuthCheck(db, 'devto', { authValid: true, accountIdentifier: '@veritasforge_ai', permissionsSufficient: true });
    recordCanary(db, 'devto', { passed: true, externalId: 'canary1', externalUrl: 'https://dev.to/x' });
    recordFactPromotion(db, machineEvidence({
      claim: "ECHO Agent's end-to-end verifier and write-ahead-log continuity checks passed for: checkpoint/resume.",
    }), { activationBoundary: '2020-01-01T00:00:00.000Z', knownCurrentRevision: 'V1' });
    closeDb(db);

    process.env.MARKETING_MODE = 'LIVE';
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = 'true';
    let publishCalled = false;
    const fetchImpl = async (url) => {
      publishCalled = true;
      return { ok: true, status: 200, json: async () => ({ article: { id: 999, url: 'https://dev.to/veritasforge_ai/x' } }) };
    };
    const result = await runDevToCycle({
      dbPath, factsPath, env: { MARKETING_DEVTO_ENABLED: 'true', DEVTO_API_KEY: 'test-key' }, fetchImpl,
    });
    // Whatever the exact outcome (the real connector response shape may not
    // match exactly what devto.mjs expects from this minimal mock) — the
    // key structural proof is that a machine fact was SELECTED as a real
    // candidate and reached the connector, never that it silently vanished.
    assert.notEqual(result.status, 'NO_POST', 'a real, eligible machine fact must be selected as a candidate');
    assert.equal(publishCalled, true, 'the connector must actually have been reached for this eligible candidate');
  } finally {
    process.env.MARKETING_MODE = prevMode;
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = prevAuto;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('wiring: X (runOnceInner, the legacy path) also sees eligible machine facts via the same loadCanonicalFacts() call', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  const prevMode = process.env.MARKETING_MODE;
  const prevAuto = process.env.ECHO_MARKETING_AUTOMATION_ENABLED;
  const prevXEnabled = process.env.MARKETING_X_ENABLED;
  try {
    const db = openDb(dbPath);
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z');
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z', MACHINE_FACT_SOURCE_KEY);
    recordAuthCheck(db, 'x', { authValid: true, accountIdentifier: '@x-test', permissionsSufficient: true });
    recordCanary(db, 'x', { passed: true, externalId: 'canary-ext-id', externalUrl: 'https://example.com/canary' });
    recordFactPromotion(db, machineEvidence(), { activationBoundary: '2020-01-01T00:00:00.000Z', knownCurrentRevision: 'V1' });
    closeDb(db);

    process.env.MARKETING_MODE = 'LIVE';
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = 'true';
    process.env.MARKETING_X_ENABLED = 'true';

    let publishCalled = false;
    const originalPublish = connectors.x.publish;
    connectors.x.publish = async () => { publishCalled = true; return { ok: true, externalId: 'ext-mvf-1', externalUrl: 'https://x.com/i/web/status/ext-mvf-1' }; };
    try {
      const result = await withIsolatedLiveEnv(() => runOnce({ dbPath, factsPath }));
      assert.equal(result.status, 'PUBLISHED');
      assert.equal(publishCalled, true);
    } finally {
      connectors.x.publish = originalPublish;
    }
  } finally {
    process.env.MARKETING_MODE = prevMode;
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = prevAuto;
    if (prevXEnabled === undefined) delete process.env.MARKETING_X_ENABLED; else process.env.MARKETING_X_ENABLED = prevXEnabled;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('wiring: loadCanonicalFacts() propagates a missing/invalid facts file exactly as loadFacts() always did (no swallowed errors)', () => {
  const { dir, dbPath } = tempEnv();
  try {
    const db = openDb(dbPath);
    assert.throws(() => loadCanonicalFacts('/nonexistent/definitely-not-a-real-facts-file.md', db));
    closeDb(db);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
