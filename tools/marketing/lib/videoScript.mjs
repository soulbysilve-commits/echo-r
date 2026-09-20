// Generates video_script.json from a PUBLIC_SAFE evidence bundle (see
// evidence.mjs) + the fact registry. 霊夢 (Reimu) is the viewer-facing
// explainer/questioner; 魔理沙 (Marisa) is the technical commentator — per
// the mandate, neither character IS the ECHO identity, they narrate about it.
//
// Structural invariant this module enforces: every line whose `importance`
// is 'technical' or 'evidence' MUST carry an `evidence_ref` pointing at
// either a FACT-* id present in the bundle or a specific log line index —
// generateVideoScript() never emits such a line without one, and
// validateScript() re-checks the invariant for anything built by hand.

function shortenForNarration(claimText) {
  // Break a long CLAIM sentence into a shorter, TTS-friendly phrase. Keep it
  // simple and mechanical (not creative rewriting) so nothing gets added
  // that isn't in the original evidenced claim. Only cut at a length limit
  // (never at the first comma — a CLAIM's first clause alone is often an
  // incomplete, confusing sentence fragment on its own).
  if (claimText.length <= 140) return claimText;
  const truncated = claimText.slice(0, 140);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > 100 ? truncated.slice(0, lastSpace) : truncated) + '...';
}

export function generateVideoScript(bundle, facts) {
  const relevantFacts = facts.filter((f) => bundle.factIds.includes(f.id));
  const lines = [];
  let t = 0;

  lines.push({
    speaker: 'reimu', text: '今回はECHO Agentに実際の作業をさせてみます。',
    start_hint: t, evidence_ref: null, visual_ref: null, importance: 'intro',
  });
  t += 4;

  for (const fact of relevantFacts) {
    lines.push({
      speaker: 'marisa',
      text: shortenForNarration(fact.CLAIM),
      start_hint: t,
      evidence_ref: fact.id,
      visual_ref: null,
      importance: 'technical',
    });
    t += 6;
  }

  bundle.publicSafeLogLines.forEach((logLine, i) => {
    lines.push({
      speaker: i % 2 === 0 ? 'reimu' : 'marisa',
      text: logLine,
      start_hint: t,
      evidence_ref: `log:${i}`,
      visual_ref: 'log_overlay',
      importance: 'evidence',
    });
    t += 3;
  });

  lines.push({
    speaker: 'reimu', text: '今回はここまで。実行ログ付きの本当のタスクでした。',
    start_hint: t, evidence_ref: null, visual_ref: null, importance: 'outro',
  });

  return { demoRunId: bundle.demoRunId, generatedAt: new Date().toISOString(), lines };
}

/**
 * Re-validates the "no evidence, no claim" invariant. Returns
 * { ok, violations } — a 'technical' or 'evidence' line missing evidence_ref,
 * or one whose evidence_ref doesn't resolve to a real fact id or log index in
 * the bundle, is a violation. Intro/outro lines are exempt (they're framing,
 * not factual claims about the demo).
 */
export function validateScript(script, bundle) {
  const violations = [];
  const validFactIds = new Set(bundle.factIds);
  const maxLogIndex = bundle.publicSafeLogLines.length - 1;

  for (const [i, line] of script.lines.entries()) {
    if (line.importance !== 'technical' && line.importance !== 'evidence') continue;
    if (!line.evidence_ref) {
      violations.push(`line ${i}: importance=${line.importance} but no evidence_ref`);
      continue;
    }
    if (line.evidence_ref.startsWith('log:')) {
      const idx = Number(line.evidence_ref.slice(4));
      if (!Number.isInteger(idx) || idx < 0 || idx > maxLogIndex) {
        violations.push(`line ${i}: evidence_ref ${line.evidence_ref} does not resolve to a bundle log line`);
      }
    } else if (!validFactIds.has(line.evidence_ref)) {
      violations.push(`line ${i}: evidence_ref ${line.evidence_ref} is not a fact id in this bundle`);
    }
  }
  return { ok: violations.length === 0, violations };
}
