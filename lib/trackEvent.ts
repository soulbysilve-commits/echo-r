"use client";

import type { MarketingEventType } from "./analyticsEvents";

// Not wired into any page yet — deliberately. Checkout-adjacent components
// (EchoAgentCheckoutButton, order-status, download flow) are mid-development
// elsewhere in this repo and are left untouched here; wire trackEvent(...)
// into them as a follow-up once that work has landed and this branch is
// reconciled with main.
export function trackEvent(eventType: MarketingEventType, extra: { path?: string } = {}) {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);

  const payload = {
    event_type: eventType,
    path: extra.path ?? window.location.pathname,
    locale: document.documentElement.lang || null,
    utm_source: params.get("utm_source"),
    utm_medium: params.get("utm_medium"),
    utm_campaign: params.get("utm_campaign"),
    utm_content: params.get("utm_content"),
    referrer: document.referrer || null,
  };

  // Fire-and-forget; never block or throw on the caller's behalf.
  fetch("/api/marketing-event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    keepalive: true,
  }).catch(() => {});
}
