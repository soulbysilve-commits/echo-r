// Evidence bundle capture + redaction gate (mandate sections 15-16). Raw
// evidence (terminal logs, screenshots, etc.) must pass a secret/privacy
// scan before anything downstream (a script, a YMM4 import, a video) is
// allowed to touch it. If the scan can't clear something, the pipeline
// blocks rather than guessing.
import { redact } from './redact.mjs';

// Patterns beyond the generic secret-shapes in redact.mjs that specifically
// matter for evidence meant to become public video content.
const PRIVACY_PATTERNS = [
  { name: 'EMAIL', re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
  { name: 'ENV_FILE_LINE', re: /^\s*[A-Z_][A-Z0-9_]*\s*=\s*.+$/gm },
  { name: 'PRIVATE_IPV4', re: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g },
  { name: 'STRIPE_ID', re: /\b(?:cus|ch|pi|sub|price|prod)_[A-Za-z0-9]{10,}\b/g },
  { name: 'COOKIE_HEADER', re: /Cookie:\s*.+/gi },
];

/**
 * Scans raw evidence text for secrets/privacy-sensitive content. Returns
 * { clean: boolean, findings: string[] (pattern names found), redactedText }.
 * `redactedText` is always safe to log for debugging what was found, but
 * callers must check `clean` before treating the ORIGINAL text as public-safe
 * — redaction masks known shapes, it does not certify nothing was missed.
 */
export function scanEvidence(rawText) {
  const findings = [];
  for (const { name, re } of PRIVACY_PATTERNS) {
    if (re.test(rawText)) findings.push(name);
    re.lastIndex = 0;
  }
  // redact.mjs's generic secret-shape patterns (API keys, bearer tokens, etc.)
  const afterGenericRedaction = redact(rawText);
  if (afterGenericRedaction !== rawText) findings.push('GENERIC_SECRET_SHAPE');

  let redactedText = afterGenericRedaction;
  for (const { re } of PRIVACY_PATTERNS) {
    redactedText = redactedText.replace(re, '[REDACTED]');
  }

  return { clean: findings.length === 0, findings, redactedText };
}

/**
 * Builds a PUBLIC_SAFE evidence bundle from raw captured evidence lines.
 * Each line is independently scanned; if ANY line fails the scan, the whole
 * bundle is blocked (`VIDEO_PUBLICATION_BLOCKED`) rather than silently
 * dropping the offending line and continuing — a partially-redacted bundle
 * with no human review is exactly the failure mode this gate exists to catch.
 */
export function buildPublicSafeBundle({ demoRunId, factIds = [], rawLogLines = [], screenshotPaths = [] }) {
  const lineFindings = rawLogLines.map((line) => ({ line, ...scanEvidence(line) }));
  const blocked = lineFindings.filter((l) => !l.clean);

  if (blocked.length > 0) {
    return {
      ok: false,
      status: 'VIDEO_PUBLICATION_BLOCKED',
      reason: `${blocked.length} of ${rawLogLines.length} evidence line(s) failed the privacy/secret scan`,
      findings: [...new Set(blocked.flatMap((l) => l.findings))],
    };
  }

  return {
    ok: true,
    status: 'PUBLIC_SAFE',
    bundle: {
      demoRunId,
      factIds,
      publicSafeLogLines: rawLogLines, // already confirmed clean above
      screenshotPaths, // paths only — this module does not itself scan image content
      createdAt: new Date().toISOString(),
    },
  };
}
