import { describe, it, expect } from 'vitest';
import { ReputationLedger } from '../../src/reputation.js';
import { ConfidenceTier, Independence, ChallengeGrounds } from '../../src/ontology.js';
import type { ContestationGraph, Verdict } from '../../src/types.js';

const AUTHOR='***';
const GOOD = '0xGoodCorroborator';
const BAD = '0xBadChallenger';

function settledGraph(): ContestationGraph {
  return {
    claim: { id: 'c1', statement: 's', author: AUTHOR, createdAt: 't' },
    corroborations: [
      { id: 'co1', supports: 'c1', corroborator: GOOD, independence: Independence.IndependentSource, evidence: [], createdAt: 't' },
    ],
    challenges: [
      { id: 'ch1', targets: 'c1', challenger: BAD, groundsType: ChallengeGrounds.Contradiction, evidence: [], createdAt: 't' },
    ],
  };
}

function verdict(tier: ConfidenceTier, openChallenges: number): Verdict {
  return { claimId: 'c1', score: 0, confidence: 0, tier, independentCorroborators: 1, openChallenges };
}

describe('ReputationLedger', () => {
  it('new agents start at the initial rep', () => {
    const led = new ReputationLedger();
    expect(led.get('0xNew').rep).toBeCloseTo(0.5);
    expect(led.get('0xNew').samples).toBe(0);
  });

  it('rewards a corroborator when their claim survives', () => {
    const led = new ReputationLedger();
    led.settle(settledGraph(), verdict(ConfidenceTier.ConsensusVerified, 0));
    expect(led.get(GOOD).rep).toBeGreaterThan(0.5);
    expect(led.get(GOOD).samples).toBe(1);
  });

  it('penalises a challenger when the claim they attacked survives', () => {
    const led = new ReputationLedger();
    led.settle(settledGraph(), verdict(ConfidenceTier.Endorsed, 0));
    expect(led.get(BAD).rep).toBeLessThan(0.5);
  });

  it('rewards a challenger when the claim collapses', () => {
    const led = new ReputationLedger();
    led.settle(settledGraph(), verdict(ConfidenceTier.SelfAttested, 1));
    expect(led.get(BAD).rep).toBeGreaterThan(0.5);
  });

  it('EWMA converges toward 1 under repeated wins', () => {
    const led = new ReputationLedger();
    for (let i = 0; i < 25; i++) {
      led.settle(settledGraph(), verdict(ConfidenceTier.ConsensusVerified, 0));
    }
    expect(led.get(GOOD).rep).toBeGreaterThan(0.9);
    expect(led.get(AUTHOR).rep).toBeGreaterThan(0.9); // author rewarded too
  });

  it('view() is an isolated snapshot', () => {
    const led = new ReputationLedger();
    led.settle(settledGraph(), verdict(ConfidenceTier.Endorsed, 0));
    const snap = led.view();
    snap.clear();
    expect(led.get(GOOD).samples).toBe(1); // mutation of snapshot did not affect ledger
  });
});
