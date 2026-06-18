import { describe, it, expect } from 'vitest';
import {
  computeConfidence,
  classifyTier,
  clamp01,
  logistic,
  DEFAULT_PARAMS,
} from '../../src/confidence.js';
import {
  ChallengeGrounds,
  ConfidenceTier,
  EvidenceKind,
  Independence,
} from '../../src/ontology.js';
import { ReputationLedger } from '../../src/reputation.js';
import type {
  Challenge,
  Claim,
  ContestationGraph,
  Corroboration,
  Evidence,
} from '../../src/types.js';

const AUTHOR = '0xAuthor';
const AGENT_B = '0xBob';
const AGENT_C = '0xCarol';
const AGENT_D = '0xDave';

function claim(over: Partial<Claim> = {}): Claim {
  return {
    id: 'claim:1',
    statement: 'The sky is blue.',
    author: AUTHOR,
    createdAt: '2026-06-17T00:00:00Z',
    ...over,
  };
}

function ev(id: string, kind: Evidence['kind'], source: string): Evidence {
  return { id, kind, source, hash: `h:${id}` };
}

function corro(over: Partial<Corroboration> & { corroborator: string }): Corroboration {
  return {
    id: `corro:${Math.random()}`,
    supports: 'claim:1',
    independence: Independence.IndependentSource,
    evidence: [],
    createdAt: '2026-06-17T01:00:00Z',
    ...over,
  };
}

function chal(over: Partial<Challenge> & { challenger: string }): Challenge {
  return {
    id: `chal:${Math.random()}`,
    targets: 'claim:1',
    groundsType: ChallengeGrounds.Contradiction,
    evidence: [],
    createdAt: '2026-06-17T01:00:00Z',
    ...over,
  };
}

function graph(over: Partial<ContestationGraph> = {}): ContestationGraph {
  return { claim: claim(), challenges: [], corroborations: [], ...over };
}

describe('helpers', () => {
  it('clamp01 bounds and handles NaN', () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(NaN)).toBe(0);
  });

  it('logistic is monotone and centered at 0.5', () => {
    expect(logistic(0)).toBeCloseTo(0.5);
    expect(logistic(10)).toBeGreaterThan(0.99);
    expect(logistic(-10)).toBeLessThan(0.01);
  });
});

describe('confidence kernel — anchoring', () => {
  it('an uncontested claim sits exactly at the self-attested floor c0', () => {
    const v = computeConfidence(graph());
    expect(v.confidence).toBeCloseTo(DEFAULT_PARAMS.c0);
    expect(v.tier).toBe(ConfidenceTier.SelfAttested);
    expect(v.openChallenges).toBe(0);
    expect(v.independentCorroborators).toBe(0);
  });
});

describe('confidence kernel — corroboration raises confidence', () => {
  it('one independent on-chain corroboration lifts confidence above c0', () => {
    const g = graph({
      corroborations: [
        corro({
          corroborator: AGENT_B,
          evidence: [ev('e1', EvidenceKind.OnChainFact, 'tx:0xabc')],
        }),
      ],
    });
    const v = computeConfidence(g);
    expect(v.confidence).toBeGreaterThan(DEFAULT_PARAMS.c0);
    expect(v.independentCorroborators).toBe(1);
  });

  it('stronger evidence kind yields higher confidence', () => {
    const withCitation = computeConfidence(graph({
      corroborations: [corro({ corroborator: AGENT_B, evidence: [ev('e', EvidenceKind.Citation, 's1')] })],
    }));
    const withOnChain = computeConfidence(graph({
      corroborations: [corro({ corroborator: AGENT_B, evidence: [ev('e', EvidenceKind.OnChainFact, 's1')] })],
    }));
    expect(withOnChain.confidence).toBeGreaterThan(withCitation.confidence);
  });

  it('multiple independent corroborators reach consensus-verified', () => {
    const g = graph({
      corroborations: [
        corro({ corroborator: AGENT_B, evidence: [ev('e1', EvidenceKind.OnChainFact, 's1')] }),
        corro({ corroborator: AGENT_C, evidence: [ev('e2', EvidenceKind.OnChainFact, 's2')] }),
        corro({ corroborator: AGENT_D, evidence: [ev('e3', EvidenceKind.OnChainFact, 's3')] }),
      ],
    });
    const v = computeConfidence(g);
    expect(v.independentCorroborators).toBe(3);
    expect(v.tier).toBe(ConfidenceTier.ConsensusVerified);
  });
});

describe('confidence kernel — challenge lowers confidence', () => {
  it('an open challenge with evidence pulls confidence below c0', () => {
    const g = graph({
      challenges: [chal({ challenger: AGENT_B, evidence: [ev('e', EvidenceKind.OnChainFact, 's1')] })],
    });
    const v = computeConfidence(g);
    expect(v.confidence).toBeLessThan(DEFAULT_PARAMS.c0);
    expect(v.openChallenges).toBe(1);
    expect(v.tier).toBe(ConfidenceTier.SelfAttested);
  });

  it('a fully rebutted challenge stops counting as open', () => {
    const challenge = chal({ challenger: AGENT_B, evidence: [ev('e', EvidenceKind.Measurement, 's1')] });
    const g = graph({
      challenges: [challenge],
      corroborations: [
        // author rebuts their own claim, fully
        corro({ corroborator: AUTHOR, rebuts: challenge.id, rebuttalStrength: 1 }),
        // plus an independent corroboration to clear the endorsed bar
        corro({ corroborator: AGENT_C, evidence: [ev('e2', EvidenceKind.OnChainFact, 's2')] }),
      ],
    });
    const v = computeConfidence(g);
    expect(v.openChallenges).toBe(0);
  });
});

describe('anti-gaming — the diversity discount indep()', () => {
  it('self-corroboration by the claim author does not count', () => {
    const g = graph({
      corroborations: [corro({ corroborator: AUTHOR, evidence: [ev('e', EvidenceKind.OnChainFact, 's1')] })],
    });
    const v = computeConfidence(g);
    expect(v.confidence).toBeCloseTo(DEFAULT_PARAMS.c0);
    expect(v.independentCorroborators).toBe(0);
  });

  it('recycled evidence source is discounted vs a fresh source', () => {
    // Two corroborators citing the SAME source — the second should add little.
    const shared = computeConfidence(graph({
      corroborations: [
        corro({ corroborator: AGENT_B, evidence: [ev('e1', EvidenceKind.OnChainFact, 'same')] }),
        corro({ corroborator: AGENT_C, evidence: [ev('e2', EvidenceKind.OnChainFact, 'same')] }),
      ],
    }));
    const fresh = computeConfidence(graph({
      corroborations: [
        corro({ corroborator: AGENT_B, evidence: [ev('e1', EvidenceKind.OnChainFact, 'src-1')] }),
        corro({ corroborator: AGENT_C, evidence: [ev('e2', EvidenceKind.OnChainFact, 'src-2')] }),
      ],
    }));
    expect(fresh.confidence).toBeGreaterThan(shared.confidence);
  });

  it('partial (Jaccard) source overlap is discounted between fully-shared and fully-fresh', () => {
    // B cites {s1,s2}; C cites {s2,s3} → Jaccard = 1/3. Confidence should land
    // strictly between the all-shared and all-fresh extremes — proving the
    // discount is graded, not binary (operator review §2).
    const partial = computeConfidence(graph({
      corroborations: [
        corro({ corroborator: AGENT_B, evidence: [ev('e1', EvidenceKind.OnChainFact, 's1'), ev('e2', EvidenceKind.OnChainFact, 's2')] }),
        corro({ corroborator: AGENT_C, evidence: [ev('e3', EvidenceKind.OnChainFact, 's2'), ev('e4', EvidenceKind.OnChainFact, 's3')] }),
      ],
    }));
    const allShared = computeConfidence(graph({
      corroborations: [
        corro({ corroborator: AGENT_B, evidence: [ev('e1', EvidenceKind.OnChainFact, 's2')] }),
        corro({ corroborator: AGENT_C, evidence: [ev('e2', EvidenceKind.OnChainFact, 's2')] }),
      ],
    }));
    const allFresh = computeConfidence(graph({
      corroborations: [
        corro({ corroborator: AGENT_B, evidence: [ev('e1', EvidenceKind.OnChainFact, 'a')] }),
        corro({ corroborator: AGENT_C, evidence: [ev('e2', EvidenceKind.OnChainFact, 'b')] }),
      ],
    }));
    expect(partial.confidence).toBeGreaterThan(allShared.confidence);
    expect(partial.confidence).toBeLessThan(allFresh.confidence);
  });

  it('co-occurrence in time amplifies the correlation discount (swarm signal)', () => {
    // PARTIAL overlap (Jaccard 1/3) so the time-amplifier has headroom — at full
    // overlap the discount already saturates. B cites {s1,s2}; C cites {s2,s3}.
    // Tight timing (inside window) should yield STRICTLY lower confidence than
    // the same overlap spread days apart.
    const t0 = '2026-06-17T01:00:00Z';
    const tNear = '2026-06-17T01:00:30Z'; // +30s, inside 5-min window
    const tFar = '2026-06-25T01:00:00Z';  // +8 days, outside window
    const bEv = [ev('e1', EvidenceKind.OnChainFact, 's1'), ev('e2', EvidenceKind.OnChainFact, 's2')];
    const cEv = [ev('e3', EvidenceKind.OnChainFact, 's2'), ev('e4', EvidenceKind.OnChainFact, 's3')];
    const swarm = computeConfidence(graph({
      corroborations: [
        corro({ corroborator: AGENT_B, createdAt: t0, evidence: bEv }),
        corro({ corroborator: AGENT_C, createdAt: tNear, evidence: cEv }),
      ],
    }));
    const spread = computeConfidence(graph({
      corroborations: [
        corro({ corroborator: AGENT_B, createdAt: t0, evidence: bEv }),
        corro({ corroborator: AGENT_C, createdAt: tFar, evidence: cEv }),
      ],
    }));
    expect(swarm.confidence).toBeLessThan(spread.confidence);
  });

  it('a challenger reusing a corroborator\'s source is NOT cross-penalized', () => {
    // Independence is measured WITHIN each cohort. A skeptic citing the same
    // on-chain fact to argue the opposite is legitimate adversarial reuse — it
    // must retain full challenge force, not be discounted as a sybil twin.
    const g = graph({
      corroborations: [corro({ corroborator: AGENT_B, evidence: [ev('e1', EvidenceKind.OnChainFact, 'tx:shared')] })],
      challenges: [chal({ challenger: AGENT_C, groundsType: ChallengeGrounds.Contradiction, evidence: [ev('e2', EvidenceKind.OnChainFact, 'tx:shared')] })],
    });
    const crossReuse = computeConfidence(g);
    // Compare to a challenger citing a totally different source: the challenge
    // force should be identical (no cross-cohort correlation discount applied).
    const g2 = graph({
      corroborations: [corro({ corroborator: AGENT_B, evidence: [ev('e1', EvidenceKind.OnChainFact, 'tx:shared')] })],
      challenges: [chal({ challenger: AGENT_C, groundsType: ChallengeGrounds.Contradiction, evidence: [ev('e2', EvidenceKind.OnChainFact, 'tx:other')] })],
    });
    const freshReuse = computeConfidence(g2);
    expect(crossReuse.confidence).toBeCloseTo(freshReuse.confidence);
  });
});

describe('reputation weighting', () => {
  it('a high-rep corroborator moves confidence more than a low-rep one', () => {
    const reps = new ReputationLedger();
    // Drive AGENT_B high and AGENT_D low via settled outcomes is heavy here;
    // instead seed via repeated observations using the public settle path is
    // overkill — use two ledgers with manual EWMA convergence.
    const highRep = new Map([[AGENT_B.toLowerCase(), { agent: AGENT_B, rep: 0.95, samples: 10 }]]);
    const lowRep = new Map([[AGENT_B.toLowerCase(), { agent: AGENT_B, rep: 0.1, samples: 10 }]]);
    const g = graph({
      corroborations: [corro({ corroborator: AGENT_B, evidence: [ev('e', EvidenceKind.OnChainFact, 's')] })],
    });
    const high = computeConfidence(g, highRep);
    const low = computeConfidence(g, lowRep);
    expect(high.confidence).toBeGreaterThan(low.confidence);
    void reps;
  });
});

describe('classifyTier thresholds', () => {
  it('respects endorsed/consensus gates', () => {
    expect(classifyTier(0.5, 1, 0)).toBe(ConfidenceTier.SelfAttested);
    expect(classifyTier(0.65, 1, 0)).toBe(ConfidenceTier.Endorsed);
    expect(classifyTier(0.65, 1, 1)).toBe(ConfidenceTier.SelfAttested); // open challenge blocks
    expect(classifyTier(0.85, 3, 0)).toBe(ConfidenceTier.ConsensusVerified);
    expect(classifyTier(0.85, 2, 0)).toBe(ConfidenceTier.Endorsed); // not enough agents
  });
});

describe('determinism', () => {
  it('same inputs → same verdict', () => {
    const g = graph({
      corroborations: [corro({ corroborator: AGENT_B, evidence: [ev('e', EvidenceKind.OnChainFact, 's')] })],
      challenges: [chal({ challenger: AGENT_C, evidence: [ev('e2', EvidenceKind.Citation, 's2')] })],
    });
    const a = computeConfidence(g);
    const b = computeConfidence(g);
    expect(a).toEqual(b);
  });
});
