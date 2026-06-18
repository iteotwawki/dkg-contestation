import { describe, it, expect } from 'vitest';
import {
  computeConfidence,
  explainConfidence,
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

  it('three COLD-START corroborators reach endorsed but NOT consensus-verified', () => {
    // With cold-start rep at the self-attested floor (0.3), three unknown agents
    // with strong evidence corroborate — enough to be endorsed, but deliberately
    // NOT enough for consensus-verified. Consensus should require PROVEN agents,
    // not three strangers (operator review: cold-start makes consensus harder —
    // that is the intended, conservative behaviour).
    const g = graph({
      corroborations: [
        corro({ corroborator: AGENT_B, evidence: [ev('e1', EvidenceKind.OnChainFact, 's1')] }),
        corro({ corroborator: AGENT_C, evidence: [ev('e2', EvidenceKind.OnChainFact, 's2')] }),
        corro({ corroborator: AGENT_D, evidence: [ev('e3', EvidenceKind.OnChainFact, 's3')] }),
      ],
    });
    const v = computeConfidence(g);
    expect(v.independentCorroborators).toBe(3);
    expect(v.tier).toBe(ConfidenceTier.Endorsed);
  });

  it('three ESTABLISHED (earned-rep) corroborators reach consensus-verified', () => {
    // The same three agents, but each has earned a strong reputation through past
    // settled outcomes. Now their agreement carries consensus weight.
    const reps = new Map([
      [AGENT_B.toLowerCase(), { agent: AGENT_B, rep: 0.9, samples: 20 }],
      [AGENT_C.toLowerCase(), { agent: AGENT_C, rep: 0.9, samples: 20 }],
      [AGENT_D.toLowerCase(), { agent: AGENT_D, rep: 0.9, samples: 20 }],
    ]);
    const g = graph({
      corroborations: [
        corro({ corroborator: AGENT_B, evidence: [ev('e1', EvidenceKind.OnChainFact, 's1')] }),
        corro({ corroborator: AGENT_C, evidence: [ev('e2', EvidenceKind.OnChainFact, 's2')] }),
        corro({ corroborator: AGENT_D, evidence: [ev('e3', EvidenceKind.OnChainFact, 's3')] }),
      ],
    });
    const v = computeConfidence(g, reps);
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
    // The challenge is a Contradiction (grounds weight 1.0); to FULLY rebut it the
    // author's rebuttal must carry evidence at least as strong (OnChainFact 1.0).
    const challenge = chal({ challenger: AGENT_B, evidence: [ev('e', EvidenceKind.Measurement, 's1')] });
    const g = graph({
      challenges: [challenge],
      corroborations: [
        // author rebuts their own claim, fully, with strong (OnChainFact) evidence
        corro({ corroborator: AUTHOR, rebuts: challenge.id, rebuttalStrength: 1,
          evidence: [ev('er', EvidenceKind.OnChainFact, 'sr')] }),
        // plus an independent corroboration to clear the endorsed bar
        corro({ corroborator: AGENT_C, evidence: [ev('e2', EvidenceKind.OnChainFact, 's2')] }),
      ],
    });
    const v = computeConfidence(g);
    expect(v.openChallenges).toBe(0);
  });

  it('a bare (no-evidence) rebuttal CANNOT close a challenge — the self-rebuttal hole', () => {
    // Author declares rebuttalStrength: 1 but attaches no evidence. Under the
    // evidence-bounded rule this caps at 0, so the challenge stays open. This is
    // the exact gaming vector the bound closes.
    const challenge = chal({ challenger: AGENT_B, groundsType: ChallengeGrounds.Contradiction,
      evidence: [ev('e', EvidenceKind.OnChainFact, 's1')] });
    const g = graph({
      challenges: [challenge],
      corroborations: [
        corro({ corroborator: AUTHOR, rebuts: challenge.id, rebuttalStrength: 1 }), // no evidence
      ],
    });
    expect(computeConfidence(g).openChallenges).toBe(1);
  });

  it('a weak rebuttal cannot fully dismiss a strong challenge (partial rebuttal stays open)', () => {
    // A Citation (0.4) rebuttal against a Contradiction (1.0) caps effective
    // strength at 0.4 — the challenge is attenuated but remains open (<1).
    const challenge = chal({ challenger: AGENT_B, groundsType: ChallengeGrounds.Contradiction,
      evidence: [ev('e', EvidenceKind.OnChainFact, 's1')] });
    const weak = graph({
      challenges: [challenge],
      corroborations: [
        corro({ corroborator: AUTHOR, rebuts: challenge.id, rebuttalStrength: 1,
          evidence: [ev('er', EvidenceKind.Citation, 'sr')] }),
      ],
    });
    const strong = graph({
      challenges: [challenge],
      corroborations: [
        corro({ corroborator: AUTHOR, rebuts: challenge.id, rebuttalStrength: 1,
          evidence: [ev('er', EvidenceKind.OnChainFact, 'sr')] }),
      ],
    });
    expect(computeConfidence(weak).openChallenges).toBe(1);   // weak rebuttal: still open
    expect(computeConfidence(strong).openChallenges).toBe(0); // strong rebuttal: closed
    // and the weak rebuttal should still lift confidence above the fully-open case
    expect(computeConfidence(weak).confidence).toBeGreaterThan(
      computeConfidence(graph({ challenges: [challenge] })).confidence,
    );
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

  it('self-CHALLENGE counts at full weight (retraction), unlike self-corroboration', () => {
    // The author disavowing their own claim is a strong negative signal — it must
    // NOT be neutralized the way self-corroboration is. A self-challenge with
    // evidence should push confidence below the floor and stay open.
    const selfChallenge = chal({ challenger: AUTHOR, groundsType: ChallengeGrounds.Contradiction,
      evidence: [ev('e', EvidenceKind.OnChainFact, 's1')] });
    const v = computeConfidence(graph({ challenges: [selfChallenge] }));
    expect(v.openChallenges).toBe(1);
    expect(v.confidence).toBeLessThan(DEFAULT_PARAMS.c0);
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

describe('explainConfidence — observability', () => {
  it('contribution lines sum to pressure, and verdict matches computeConfidence', () => {
    const g = graph({
      corroborations: [
        corro({ corroborator: AGENT_B, evidence: [ev('e1', EvidenceKind.OnChainFact, 's1')] }),
        corro({ corroborator: AGENT_C, evidence: [ev('e2', EvidenceKind.Measurement, 's2')] }),
      ],
      challenges: [
        chal({ challenger: AGENT_D, groundsType: ChallengeGrounds.StaleData,
          evidence: [ev('e3', EvidenceKind.Citation, 's3')] }),
      ],
    });
    const ex = explainConfidence(g);
    // verdict is identical to computeConfidence (one source of truth)
    expect(ex.verdict).toEqual(computeConfidence(g));
    // lines reconcile: Σ contribution === pressure
    const summed = ex.lines.reduce((acc, l) => acc + l.contribution, 0);
    expect(summed).toBeCloseTo(ex.pressure, 10);
    // and score === c0 + pressure
    expect(ex.verdict.score).toBeCloseTo(ex.c0 + ex.pressure, 10);
    // one line per non-rebuttal assertion
    expect(ex.lines.filter((l) => l.role === 'corroboration')).toHaveLength(2);
    expect(ex.lines.filter((l) => l.role === 'challenge')).toHaveLength(1);
  });

  it('exposes the indep discount per line so sybil suppression is observable', () => {
    // Two corroborators sharing a source — the second's line should show a
    // visibly reduced indep, which is the whole point of the breakdown.
    const g = graph({
      corroborations: [
        corro({ corroborator: AGENT_B, evidence: [ev('e1', EvidenceKind.OnChainFact, 'shared')] }),
        corro({ corroborator: AGENT_C, evidence: [ev('e2', EvidenceKind.OnChainFact, 'shared')] }),
      ],
    });
    const lines = explainConfidence(g).lines;
    expect(lines[0].indep).toBeGreaterThan(lines[1].indep); // recycled source discounted
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
