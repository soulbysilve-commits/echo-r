// Event quality gate (mandate section 12) + privacy default (section 13).
// Every normalized event passes through here before it may become a real
// marketing_events row. Only INGEST proceeds to the existing story-scoring
// engine unchanged — everything else is recorded for source-health/audit
// visibility (mandate section 19: report ignored/private-held counts) but
// never scored.
import { scanEvidence } from './evidence.mjs';

/**
 * `isDuplicate` is supplied by the caller (lib/sourceIngestion.mjs), which
 * is the only place that can actually check marketing_events without
 * risking a write during a dry run — this function stays pure/side-effect-free.
 */
export function evaluateEventQuality(normalizedEvent, { isDuplicate = false } = {}) {
  const sourceValid = !!(normalizedEvent.source_repository && normalizedEvent.source_kind && normalizedEvent.source_native_id);
  const evidenceExists = (normalizedEvent.evidence_refs?.length ?? 0) > 0 || (normalizedEvent.evidence_hashes?.length ?? 0) > 0;

  if (!sourceValid) return { classification: 'IGNORE', reasons: ['SOURCE_INVALID'] };
  if (!evidenceExists) return { classification: 'IGNORE', reasons: ['EVIDENCE_MISSING'] };
  if (isDuplicate) return { classification: 'IGNORE', reasons: ['DUPLICATE'] };

  if (normalizedEvent.verification_state === 'UNVERIFIED') {
    return { classification: 'IGNORE', reasons: ['VERIFICATION_STATE_UNACCEPTABLE: UNVERIFIED'] };
  }
  if (normalizedEvent.verification_state === 'CLAIMED_ONLY') {
    // A real claim exists but nothing machine-verified it — worth a human
    // look, not the same as noise (IGNORE) or a confirmed privacy concern
    // (HOLD_PRIVATE).
    return { classification: 'NEEDS_REVIEW', reasons: ['VERIFICATION_STATE_UNACCEPTABLE: CLAIMED_ONLY'] };
  }

  // Privacy default: fail closed (section 13). Independent re-scan of the
  // event's own public-facing text — an adapter's own public_safety_state
  // judgment is never trusted as the sole gate.
  if (normalizedEvent.public_safety_state === 'NOT_PUBLIC') {
    return { classification: 'HOLD_PRIVATE', reasons: ['MARKED_NOT_PUBLIC'] };
  }
  if (normalizedEvent.public_safety_state === 'NEEDS_REVIEW') {
    return { classification: 'NEEDS_REVIEW', reasons: ['PUBLIC_SAFETY_NOT_EVALUATED'] };
  }
  const text = `${normalizedEvent.title ?? ''} ${normalizedEvent.summary ?? ''}`;
  const scan = scanEvidence(text);
  if (!scan.clean) {
    return { classification: 'HOLD_PRIVATE', reasons: [`PRIVACY_SCAN_FAILED: ${scan.findings.join(',')}`] };
  }

  return { classification: 'INGEST', reasons: [] };
}
