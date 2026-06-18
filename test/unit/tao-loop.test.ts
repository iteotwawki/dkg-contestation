/**
 * TAO-loop scenario test — the credible-first-user narrative (DESIGN.md §4).
 *
 * A mining agent ("reborn") publishes a research claim; an advisor ("janus")
 * CHALLENGES it and confidence DROPS; the miner answers with stronger evidence
 * and confidence RISES again. This is the quality-signal loop the integration is
 * built to demonstrate.
 *
 * Runs against an in-memory transport so it is deterministic and CI-safe — the
 * narrative is pure protocol behaviour and needs no node. (Live HTTP round-trip
 * is proven separately by contestation.test.ts against a real DKG node.)
 */

import { describe, it, expect } from 'vitest';
import { ContestationEngine } from '../../src/engine.js';
import { ReputationLedger } from '../../src/reputation.js';
import type { DkgTransport, AssetState } from '../../src/transport.js';
import type { Quad } from '../../src/types.js';
import { ChallengeGrounds, EvidenceKind, Independence } from '../../src/ontology.js';

const REBORN = '0xRebornMiner';
const JANUS = '0xJanusAdvisor';

/** Deterministic in-memory transport — records shares, no node needed. */
class MemTransport implements DkgTransport {
  shares: string[] = [];
  private store = new Map<string, Quad[]>();
  constructor(private readonly address = REBORN) {}
  async agentAddress(): Promise<string> { return this.address; }
  async ensureContextGraph(): Promise<void> {}
  async createAssertion(): Promise<void> {}
  async writeQuads(_cg: string, name: string, quads: Quad[]): Promise<number> {
    this.store.set(name, [...(this.store.get(name) ?? []), ...quads]);
    return quads.length;
  }
  async finalize(): Promise<{ merkleRoot?: string }> { return { merkleRoot: 'm:mem' }; }
  async share(_cg: string, name: string): Promise<void> { this.shares.push(name); }
  async readQuads(_cg: string, name: string): Promise<Quad[]> { return this.store.get(name) ?? []; }
  async getAssetState(): Promise<AssetState> { return { memoryLayer: 'SWM', state: 'promoted' }; }
}

describe('TAO-loop: a research claim survives contestation (drop → rise)', () => {
  it('miner claim → advisor challenge (drops) → miner corroborates (rises)', async () => {
    const transport = new MemTransport(REBORN);
    const engine = new ContestationEngine({
      transport,
      contextGraphId: `tao-loop-${Date.now()}`,
      reputation: new ReputationLedger(),
    });

    // 1. reborn (miner) publishes a research finding
    const claim = await engine.publishClaim({
      statement: 'SN15 ORO emissions favor low-latency inference miners; topology T3 is optimal.',
      author: REBORN,
    });
    const c0 = engine.confidence(claim.id).confidence;

    // 2. a peer miner corroborates with an initial measurement → confidence rises
    await engine.corroborate({
      claimId: claim.id,
      corroborator: '0xPeerMiner',
      independence: Independence.IndependentSource,
      evidence: [{ id: 'ev:m1', kind: EvidenceKind.Measurement, source: 'taostats:run1', hash: 'h1' }],
    });
    const cAfterSupport = engine.confidence(claim.id).confidence;
    expect(cAfterSupport).toBeGreaterThan(c0);

    // 3. janus (advisor) CHALLENGES with newer, contradicting data → confidence DROPS
    const challenge = await engine.challenge({
      claimId: claim.id,
      challenger: JANUS,
      groundsType: ChallengeGrounds.StaleData,
      evidence: [{ id: 'ev:j1', kind: EvidenceKind.OnChainFact, source: 'tx:newer-emissions', hash: 'h2' }],
    });
    const afterChallenge = engine.confidence(claim.id);
    expect(afterChallenge.openChallenges).toBe(1);
    expect(afterChallenge.confidence).toBeLessThan(cAfterSupport);

    // 4. reborn answers with STRONGER (fresh on-chain) evidence that rebuts the
    //    staleness challenge → confidence RISES again, challenge closes
    await engine.corroborate({
      claimId: claim.id,
      corroborator: REBORN,
      independence: Independence.Replication,
      rebuts: challenge.id,
      rebuttalStrength: 1,
      evidence: [{ id: 'ev:m2', kind: EvidenceKind.OnChainFact, source: 'tx:fresh-emissions', hash: 'h3' }],
    });
    const afterRebuttal = engine.confidence(claim.id);
    expect(afterRebuttal.openChallenges).toBe(0);
    expect(afterRebuttal.confidence).toBeGreaterThan(afterChallenge.confidence);

    // 5. the breakdown is observable and reconciles
    const ex = engine.explain(claim.id);
    expect(ex.lines.length).toBeGreaterThanOrEqual(2);
    expect(ex.verdict.score).toBeCloseTo(ex.c0 + ex.pressure, 8);

    // 6. every assertion was shared to SWM (team-visible contestation arena)
    expect(transport.shares.length).toBeGreaterThanOrEqual(4); // claim + 2 corroborations + challenge

    // 7. settle folds the outcome into reputations
    const final = await engine.settle(claim.id);
    expect(final.claimId).toBe(claim.id);
  });
});
