// Redacts likely secrets before anything is written to a log file or the
// publication ledger. Mandate section 39 / test list item 10.

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{10,}/g,                     // generic API secret keys (OpenAI-style, etc.)
  /sk_(?:live|test)_[A-Za-z0-9]{10,}/g,         // Stripe secret keys (underscore, not hyphen — a real gap until caught by test)
  /rk_(?:live|test)_[A-Za-z0-9]{10,}/g,         // Stripe restricted keys
  /pk_(?:live|test)_[A-Za-z0-9]{10,}/g,         // Stripe publishable keys (less sensitive, still redacted)
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,              // Slack tokens
  /ghp_[A-Za-z0-9]{20,}/g,                      // GitHub PATs
  /whsec_[A-Za-z0-9]{10,}/g,                    // Stripe webhook signing secrets
  /AKIA[0-9A-Z]{12,}/g,                         // AWS/R2-style access key ids
  /Bearer\s+[A-Za-z0-9._-]{10,}/gi,             // bearer tokens
  /(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"]?[^\s'"]{6,}/gi, // generic key=value secrets
];

export function redact(text) {
  let out = String(text);
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, '[REDACTED]');
  }
  return out;
}
