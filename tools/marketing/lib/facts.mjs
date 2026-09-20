import { readFileSync } from 'node:fs';

export const VALID_STATUSES = [
  'VERIFIED',
  'PARTIAL',
  'EXPERIMENTAL',
  'PLANNED',
  'FAILED',
  'DEPRECATED',
];

// Only these statuses may back a claim that something is currently shipped/available.
export const SHIPPED_STATUSES = new Set(['VERIFIED']);

const FIELD_NAMES = [
  'PRODUCT', 'STATUS', 'CLAIM', 'SOURCE_REPOSITORY', 'SOURCE_PATH',
  'SOURCE_EVIDENCE', 'VERIFIED_AT', 'PUBLIC_SAFE', 'NOTES',
];

/**
 * Parse docs/marketing/VERITAS_FORGE_PUBLIC_FACTS.md into structured facts.
 * Format (one block per fact):
 *
 * ## FACT-001
 * PRODUCT: ECHO Agent
 * STATUS: VERIFIED
 * CLAIM: ...
 * SOURCE_REPOSITORY: ...
 * SOURCE_PATH: ...
 * SOURCE_EVIDENCE: ...
 * VERIFIED_AT: 2026-09-13
 * PUBLIC_SAFE: true
 * NOTES: ...
 */
export function parseFacts(markdown) {
  const facts = [];
  const blocks = markdown.split(/^##\s+/m).slice(1);

  for (const block of blocks) {
    const lines = block.split('\n');
    const id = lines[0].trim();
    if (!/^FACT-\d+$/.test(id)) continue;

    const fact = { id };
    let currentField = null;
    for (const line of lines.slice(1)) {
      const match = line.match(/^([A-Z_]+):\s?(.*)$/);
      if (match && FIELD_NAMES.includes(match[1])) {
        currentField = match[1];
        fact[currentField] = match[2].trim();
      } else if (currentField && line.trim()) {
        // continuation of a multi-line field
        fact[currentField] += ' ' + line.trim();
      }
    }
    facts.push(fact);
  }
  return facts;
}

export function loadFacts(path) {
  const raw = readFileSync(path, 'utf8');
  return parseFacts(raw);
}

export function validateFacts(facts) {
  const errors = [];
  const seen = new Set();
  for (const fact of facts) {
    if (seen.has(fact.id)) errors.push(`Duplicate fact id: ${fact.id}`);
    seen.add(fact.id);
    if (!VALID_STATUSES.includes(fact.STATUS)) {
      errors.push(`${fact.id}: invalid STATUS "${fact.STATUS}"`);
    }
    if (!fact.SOURCE_REPOSITORY || !fact.SOURCE_PATH) {
      errors.push(`${fact.id}: missing source repository/path evidence`);
    }
    if (!fact.CLAIM) {
      errors.push(`${fact.id}: missing CLAIM text`);
    }
  }
  return errors;
}

export function factById(facts, id) {
  return facts.find((f) => f.id === id);
}

/**
 * Can a fact be used to support a claim that something is available/shipped now?
 */
export function supportsShippedClaim(fact) {
  return !!fact && SHIPPED_STATUSES.has(fact.STATUS) && fact.PUBLIC_SAFE === 'true';
}
