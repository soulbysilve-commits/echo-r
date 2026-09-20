// Mandate section 10: MARKETING_VALUE 0-100 from a fixed set of weighted signals.
// Deliberately simple and inspectable rather than "clever" — every weight here
// is something a human can audit and adjust, not a black box.

const WEIGHTS = {
  novelty: 15,
  demonstrability: 20,
  technicalValue: 15,
  productRelevance: 15,
  identityRelevance: 10,
  agentRelevance: 10,
  visualValue: 5,
  audienceValue: 10,
};

function daysSince(dateStr) {
  if (!dateStr) return Infinity;
  const d = Date.parse(dateStr);
  if (Number.isNaN(d)) return Infinity;
  return (Date.now() - d) / (1000 * 60 * 60 * 24);
}

/**
 * Score a fact as a marketing story candidate. Only VERIFIED/PARTIAL facts
 * should be scored for AUTO-class publication; EXPERIMENTAL/PLANNED facts
 * may still be scored for clearly-labeled "in development" content.
 */
export function scoreFact(fact) {
  const signals = {
    novelty: daysSince(fact.VERIFIED_AT) < 14 ? 1 : daysSince(fact.VERIFIED_AT) < 30 ? 0.5 : 0.1,
    demonstrability: fact.SOURCE_EVIDENCE ? 1 : 0.2,
    technicalValue: fact.STATUS === 'VERIFIED' ? 1 : fact.STATUS === 'PARTIAL' ? 0.6 : 0.3,
    productRelevance: /echo agent/i.test(fact.PRODUCT ?? '') ? 1 : 0.6,
    identityRelevance: /identity|memory|continuity/i.test(fact.CLAIM ?? '') ? 1 : 0.3,
    agentRelevance: /agent|plan|verif|checkpoint|resume/i.test(fact.CLAIM ?? '') ? 1 : 0.3,
    visualValue: /demo|screenshot|video/i.test(fact.NOTES ?? '') ? 1 : 0.2,
    audienceValue: 0.6, // no channel analytics yet; neutral default until marketing_memory has data
  };

  let total = 0;
  for (const [key, weight] of Object.entries(WEIGHTS)) {
    total += (signals[key] ?? 0) * weight;
  }
  return { score: Math.round(total), signals };
}

export function rankFacts(facts) {
  return facts
    .filter((f) => f.PUBLIC_SAFE === 'true' && ['VERIFIED', 'PARTIAL'].includes(f.STATUS))
    .map((f) => ({ fact: f, ...scoreFact(f) }))
    .sort((a, b) => b.score - a.score);
}
