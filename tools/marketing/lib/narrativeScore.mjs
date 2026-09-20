// Scores whether a set of raw evidence log lines contains a genuine
// narrative arc worth the flagship series (「ECHO Agentに実際に仕事をさせてみた」,
// mandate section 9) — actual task, unexpected failure, verifier rejection,
// correction/retry, checkpoint/resume, final verified result. This never
// generates or alters evidence; it only scores lines already produced
// elsewhere, and a low score is a legitimate, expected outcome ("a boring
// real success is preferable to a fake dramatic story" — this module has
// no way to manufacture drama, only to detect it if genuinely present).
const MARKERS = {
  task: /\bGOAL ACCEPTED|\bTASK:|\bPLAN CREATED\b/i,
  failure: /\bFAILED\b|\bERROR\b|\bREJECT\b/i,
  verifierRejection: /VERIFIER.*REJECT|REJECT.*VERIFIER/i,
  retry: /\bRETRY\b|\bfix applied\b|\bcorrection\b/i,
  checkpoint: /\bCHECKPOINT\b|\bRESUME\b/i,
  finalResult: /\bPASS\b|\bSUCCESS\b|\bRESULT\b.*SUCCESS|\bVERIFIER.*PASS/i,
};

/**
 * Returns which narrative beats are present and a 0-6 score (one point per
 * distinct beat found). This is a signal for humans/selection logic to
 * weigh, not an automatic accept/reject gate — no threshold here decides
 * whether a video gets made.
 */
export function scoreNarrative(rawLogLines) {
  const text = rawLogLines.join('\n');
  const beats = Object.fromEntries(
    Object.entries(MARKERS).map(([name, re]) => [name, re.test(text)])
  );
  const score = Object.values(beats).filter(Boolean).length;
  return { score, beats, lineCount: rawLogLines.length };
}

/**
 * A convenience label, not a gate: "FLAGSHIP_CANDIDATE" when the full
 * arc (failure -> verifier rejection -> retry -> final result) is present,
 * "PARTIAL_ARC" when some beats are present, "ROUTINE" otherwise. A
 * ROUTINE/PARTIAL story is still perfectly valid content — this label only
 * helps a human prioritize, per mandate section 9's own instruction not to
 * manufacture drama.
 */
export function classifyNarrative(rawLogLines) {
  const { score, beats } = scoreNarrative(rawLogLines);
  const hasFullArc = beats.failure && beats.verifierRejection && beats.retry && beats.finalResult;
  // "task" and "finalResult" alone describe every ordinary success too —
  // only count as story tension if at least one beat beyond those two
  // ordinary ones is present. Otherwise a routine success (task -> success)
  // would wrongly score as PARTIAL_ARC just for existing.
  const hasAnyTension = beats.failure || beats.verifierRejection || beats.retry || beats.checkpoint;
  if (hasFullArc) return { label: 'FLAGSHIP_CANDIDATE', score, beats };
  if (hasAnyTension) return { label: 'PARTIAL_ARC', score, beats };
  return { label: 'ROUTINE', score, beats };
}
