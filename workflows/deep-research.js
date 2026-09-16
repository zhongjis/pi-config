export const meta = {
  name: 'deep-research', description: 'Bounded research with independent evidence verification',
  phases: [{ title: 'Discover' }, { title: 'Challenge' }, { title: 'Verify' }],
  inputSchema: {
    type: 'object', properties: {
      question: { type: 'string', pattern: '\\S' },
      requirements: { type: 'array', minItems: 1, maxItems: 6, uniqueItems: true, items: { type: 'string', pattern: '\\S' } },
      readOnlyAgentType: { type: 'string', pattern: '\\S' }, evidenceContext: { type: 'string', pattern: '\\S' },
      maxRounds: { type: 'integer', minimum: 1, maximum: 3 }
    }, required: ['question', 'requirements', 'readOnlyAgentType', 'evidenceContext'], additionalProperties: false
  }
};
const requirements = args.requirements.map(value => value.trim());
if (new Set(requirements).size !== requirements.length) throw new Error('Requirements must be unique after trimming');
const text = { type: 'string', pattern: '\\S' };
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const list = (items, maxItems) => ({ type: 'array', items, maxItems });
const discoverySchema = object({
  evidence: list(object({ source: text, excerpt: text }), 3),
  claims: list(object({ requirement: text, text, evidenceIndexes: { ...list({ type: 'integer', minimum: 0 }, 3), minItems: 1 } }), 3),
  followUps: list(object({ requirement: text, question: text }), 3)
});
const challengeSchema = object({ challenges: list(object({ claimId: text, reason: text }), 27) });
const verificationSchema = object({ verdicts: list(object({
  claimId: text, supported: { type: 'boolean' }, reason: text,
  evidence: list(object({ evidenceId: text, source: text, excerpt: text }), 3), resolves: list(text, 81)
}), 27) });
const coverage = requirements.map(requirement => ({ requirement, attempted: [], missing: [], rejected: [], deferred: [], verified: false, unresolved: true }));
const frontier = requirements.map((requirement, index) => ({ id: `q${index + 1}`, requirement, question: requirement, attempted: false }));
const deferredQuestions = [];
const evidence = [];
const claims = [];
const rejectedClaims = [];
const challenges = [];
const missingStages = [];
const seenQuestions = new Set(frontier.map(item => JSON.stringify([item.requirement, item.question])));
let rounds = 0;
let scheduledCalls = 0;
let stopReason = 'round_limit';
let previousStrength = 0;
let previousCoverage = 0;
let previousResolved = 0;
let verificationFailed = false;
const call = (stage, payload, schema) => {
  scheduledCalls++;
  return agent(`${stage.instructions}\n${JSON.stringify({ question: args.question, evidenceContext: args.evidenceContext, requirements, ...payload })}`, {
    agentType: args.readOnlyAgentType, phase: stage.phase, label: stage.label, key: stage.label, schema
  });
};
for (let round = 1; round <= (args.maxRounds ?? 3); round++) {
  rounds = round;
  const batch = frontier.filter(item => !item.attempted).slice(0, 3);
  const discovered = await parallel(batch.map(item => () => call({
    phase: 'Discover', label: `discover:${item.id.slice(1)}`,
    instructions: 'Read only. Investigate the frontier question using the evidence context. Return source locations and excerpts, claims tied to exact requirements, and useful follow-up questions. evidenceIndexes are zero-based within your evidence array. Do not treat agreement as proof.'
  }, { item }, discoverySchema)));
  batch.forEach((item, index) => {
    item.attempted = true;
    const covered = coverage.find(entry => entry.requirement === item.requirement);
    covered.attempted.push(item.id);
    const result = discovered[index];
    if (result === null) { covered.missing.push(item.id); return; }
    const localEvidence = result.evidence.map(value => {
      const entry = { id: `e${evidence.length + 1}`, questionId: item.id, ...value };
      evidence.push(entry);
      return entry;
    });
    for (const value of result.claims) {
      const valid = requirements.includes(value.requirement)
        && new Set(value.evidenceIndexes).size === value.evidenceIndexes.length
        && value.evidenceIndexes.every(index => localEvidence[index]);
      claims.push({ id: `c${claims.length + 1}`, questionId: item.id, requirement: value.requirement, text: value.text,
        evidenceIds: value.evidenceIndexes.flatMap(index => localEvidence[index] ? [localEvidence[index].id] : []),
        valid, status: valid ? 'unverified' : 'rejected', reason: valid ? '' : 'invalid_evidence', verifiedEvidence: [] });
    }
    for (const followUp of result.followUps) {
      const requirement = followUp.requirement.trim();
      const question = followUp.question.trim();
      const identity = JSON.stringify([requirement, question]);
      if (seenQuestions.has(identity)) continue;
      seenQuestions.add(identity);
      if (!requirements.includes(requirement) || frontier.length === 12) {
        deferredQuestions.push({ ...followUp, reason: requirements.includes(requirement) ? 'frontier_limit' : 'unknown_requirement' });
      } else frontier.push({ id: `q${frontier.length + 1}`, requirement, question, attempted: false });
    }
  });
  const [skeptic] = await parallel([() => call({
    phase: 'Challenge', label: `skeptic:${round}`,
    instructions: 'Read only. Fresh skeptical review: inspect sources for contradictions and unsupported claims. Challenge claim IDs with concrete reasons. Disagreement is triage, never proof. Existing unresolved challenges remain unless independently resolved.'
  }, { evidence, claims, challenges }, challengeSchema)]);
  if (skeptic === null) missingStages.push(`skeptic:${round}`);
  else for (const challenge of skeptic.challenges) {
    if (!claims.some(claim => claim.id === challenge.claimId)) verificationFailed = true;
    challenges.push({ id: `h${challenges.length + 1}`, ...challenge, resolved: false });
  }
  const [verification] = await parallel([() => call({
    phase: 'Verify', label: `verifier:${round}`,
    instructions: 'Read only. Independently inspect authoritative sources; never count votes or trust discovery summaries as proof. Check each claim against its cited evidence and all challenges. Return supported only with inspected evidence IDs, exact source locations and source excerpts. resolves lists challenge IDs actually resolved by this evidence. Omitted claims remain unverified. Reject contradictions that cannot be resolved.'
  }, { evidence, claims, challenges }, verificationSchema)]);
  for (const claim of claims) if (claim.valid) { claim.status = 'unverified'; claim.verifiedEvidence = []; }
  if (verification === null) missingStages.push(`verifier:${round}`);
  else {
    const seenClaims = new Set();
    for (const verdict of verification.verdicts) {
      const claim = claims.find(entry => entry.id === verdict.claimId);
      if (!claim || seenClaims.has(verdict.claimId)) {
        verificationFailed = true;
        if (claim) { claim.status = 'rejected'; claim.reason = 'duplicate_verdict'; claim.verifiedEvidence = []; }
        continue;
      }
      seenClaims.add(verdict.claimId);
      if (!claim.valid) continue;
      const validEvidence = verdict.evidence.length > 0 && verdict.evidence.every(citation =>
        claim.evidenceIds.includes(citation.evidenceId) && evidence.some(entry => entry.id === citation.evidenceId && entry.source === citation.source));
      const validResolutions = verdict.resolves.every(id => challenges.some(entry => entry.id === id && entry.claimId === claim.id));
      if ((verdict.supported && !validEvidence) || !validResolutions) {
        verificationFailed = true; claim.status = 'rejected'; claim.reason = 'invalid_verification'; continue;
      }
      claim.status = verdict.supported ? 'supported' : 'rejected';
      claim.reason = verdict.reason;
      if (verdict.supported) {
        claim.verifiedEvidence = verdict.evidence;
        for (const challenge of challenges) if (verdict.resolves.includes(challenge.id)) challenge.resolved = true;
      }
    }
  }
  for (const claim of claims) if (claim.status !== 'rejected' && challenges.some(entry => entry.claimId === claim.id && !entry.resolved)) claim.status = 'contested';
  for (const claim of claims) if (claim.status === 'rejected') rejectedClaims.push({ ...claim, round });
  for (const item of coverage) {
    const related = claims.filter(claim => claim.requirement === item.requirement);
    item.rejected = [...new Set(rejectedClaims.filter(claim => claim.requirement === item.requirement).map(claim => claim.id))];
    item.verified = related.some(claim => claim.status === 'supported');
    item.unresolved = !item.verified || related.some(claim => claim.status === 'contested');
  }
  const strength = new Set(claims.filter(claim => claim.status === 'supported').flatMap(claim => claim.verifiedEvidence.map(entry => entry.source))).size;
  const verifiedCoverage = coverage.filter(item => item.verified && !item.unresolved).length;
  const resolved = challenges.filter(item => item.resolved).length;
  const improved = strength > previousStrength || verifiedCoverage > previousCoverage || resolved > previousResolved;
  previousStrength = Math.max(previousStrength, strength);
  previousCoverage = Math.max(previousCoverage, verifiedCoverage);
  previousResolved = Math.max(previousResolved, resolved);
  if (missingStages.length || coverage.some(item => item.missing.length)) { stopReason = 'missing_required_result'; break; }
  if (verificationFailed) { stopReason = 'verification_failed'; break; }
  if (verifiedCoverage === requirements.length) { stopReason = 'covered'; break; }
  if (!frontier.some(item => !item.attempted)) { stopReason = 'frontier_exhausted'; break; }
  if (!improved) { stopReason = 'converged'; break; }
}
for (const item of coverage) item.deferred = frontier.filter(entry => entry.requirement === item.requirement && !entry.attempted).map(entry => entry.id);
return {
  accepted: stopReason === 'covered', stopReason,
  citedFindings: claims.filter(claim => claim.status === 'supported').map(claim => ({ ...claim, evidenceIds: claim.verifiedEvidence.map(entry => entry.evidenceId) })),
  contestedClaims: claims.filter(claim => claim.status === 'contested'), rejectedClaims,
  gaps: coverage.filter(item => item.unresolved), coverage, evidence, claims, challenges, frontier, deferredQuestions, missingStages,
  metrics: { rounds, scheduledCalls, frontierQuestions: frontier.length, evidenceStrength: previousStrength, verifiedCoverage: previousCoverage, resolvedChallenges: previousResolved }
};
