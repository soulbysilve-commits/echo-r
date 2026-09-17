/**
 * Order-record relay for confirmed ECHO Agent Stripe events.
 *
 * Mirrors the existing app/api/echo-early-access/route.ts pattern
 * exactly (forward a minimal record to an operator-configured webhook
 * URL, secret sent in the body, response tells the caller whether this
 * was a duplicate) rather than inventing a second storage system for
 * this site. This site has no database configured today; delegating
 * storage and dedup to the operator's existing downstream automation
 * (the same one early-access already relies on) is the documented
 * "Phase 1" scope for this integration -- see PAYMENT_OPERATIONS.md.
 *
 * Never include card data, the Stripe secret key, or the webhook
 * signing secret in the forwarded body -- only the minimal purchase
 * record fields a human needs to hand-deliver access.
 */

export type EchoAgentOrderRecord = {
  eventId: string;
  eventType: string;
  stripeCustomerId: string | null;
  checkoutSessionId: string | null;
  paymentIntentId: string | null;
  subscriptionId: string | null;
  product: string;
  status: string;
  customerEmail: string | null;
  amountTotal: number | null;
  currency: string | null;
  createdAt: string;
};

export type OrderRelayResult = {
  forwarded: boolean;
  duplicate: boolean;
  error?: string;
};

export async function relayEchoAgentOrder(
  record: EchoAgentOrderRecord
): Promise<OrderRelayResult> {
  const webhookUrl = process.env.ECHO_AGENT_ORDER_WEBHOOK_URL;
  const webhookSecret = process.env.ECHO_AGENT_ORDER_WEBHOOK_SECRET;

  if (!webhookUrl || !webhookSecret) {
    console.error(
      "ECHO Agent order relay is not configured (ECHO_AGENT_ORDER_WEBHOOK_URL / _SECRET missing) -- confirmed Stripe event was NOT recorded anywhere:",
      record.eventId
    );
    return { forwarded: false, duplicate: false, error: "not_configured" };
  }

  try {
    const result = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...record,
        secret: webhookSecret,
      }),
      redirect: "follow",
    });

    if (!result.ok) {
      console.error(
        "ECHO Agent order relay HTTP error:",
        result.status,
        record.eventId
      );
      return { forwarded: false, duplicate: false, error: `http_${result.status}` };
    }

    const body = await result.json().catch(() => null);

    if (!body || body.ok !== true) {
      console.error("ECHO Agent order relay rejected the record:", record.eventId, body);
      return { forwarded: false, duplicate: false, error: "rejected" };
    }

    return { forwarded: true, duplicate: body.duplicate === true };
  } catch (error) {
    console.error("ECHO Agent order relay request failed:", record.eventId, error);
    return { forwarded: false, duplicate: false, error: "request_failed" };
  }
}
