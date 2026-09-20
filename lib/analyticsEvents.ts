// Privacy-respecting first-party analytics event shape + validation.
//
// Deliberately allowlist-based, not a secret-blocklist: an event payload is
// rebuilt field-by-field from a fixed allowlist, so there is no way for an
// unexpected field (a stray payment token, a conversation excerpt, a secret
// pasted into a form) to reach storage — it would simply be dropped, not
// merely redacted after the fact.
export const EVENT_TYPES = [
  "PAGE_VIEW",
  "PRODUCT_PAGE_VIEW",
  "CTA_CLICK",
  "CHECKOUT_START",
  "CHECKOUT_SUCCESS",
  "DOWNLOAD_READY",
  "DOWNLOAD_COMPLETE",
] as const;

export type MarketingEventType = (typeof EVENT_TYPES)[number];

export type MarketingEventInput = {
  event_type: string;
  path?: unknown;
  locale?: unknown;
  utm_source?: unknown;
  utm_medium?: unknown;
  utm_campaign?: unknown;
  utm_content?: unknown;
  referrer?: unknown;
};

export type MarketingEvent = {
  event_type: MarketingEventType;
  path: string;
  locale: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  referrer_host: string | null; // host only — never the full referrer URL (may carry query params)
  received_at: string;
};

const MAX_FIELD_LENGTH = 200;

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.slice(0, MAX_FIELD_LENGTH).trim();
  return trimmed.length > 0 ? trimmed : null;
}

function hostOnly(value: unknown): string | null {
  const str = cleanString(value);
  if (!str) return null;
  try {
    return new URL(str).host;
  } catch {
    return null; // not a valid URL — drop rather than store a possibly-sensitive raw string
  }
}

export type ValidationResult =
  | { ok: true; event: MarketingEvent }
  | { ok: false; errors: string[] };

/**
 * Validates and rebuilds an event from ONLY the allowlisted fields above.
 * Never records payment/card data, Stripe secrets, R2 credentials, or
 * conversation content — those fields simply aren't in the allowlist, so
 * they can't reach the returned event no matter what the caller sent.
 */
export function validateEvent(input: MarketingEventInput): ValidationResult {
  const errors: string[] = [];

  if (!EVENT_TYPES.includes(input.event_type as MarketingEventType)) {
    errors.push(`event_type must be one of: ${EVENT_TYPES.join(", ")}`);
  }
  const path = cleanString(input.path);
  if (!path) errors.push("path is required");
  if (path && !path.startsWith("/")) errors.push("path must be a relative path");

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    event: {
      event_type: input.event_type as MarketingEventType,
      path: path as string,
      locale: cleanString(input.locale),
      utm_source: cleanString(input.utm_source),
      utm_medium: cleanString(input.utm_medium),
      utm_campaign: cleanString(input.utm_campaign),
      utm_content: cleanString(input.utm_content),
      referrer_host: hostOnly(input.referrer),
      received_at: new Date().toISOString(),
    },
  };
}
