import { describe, it, expect } from 'vitest';
import { ContestationEngine } from '../../src/engine.js';
import { ReputationLedger } from '../../src/reputation.js';
import type { DkgTransport, AssetState } from '../../src/transport.js';
import type { Quad } from '../../src/types.js';
import {
  ChallengeGrounds,
  ConfidenceTier,
  EvidenceKind,
  Independence,
} from '../../src/ontology.js';

/**
 * In-memory mock transport — records calls, needs no DKG node. Lets us exercise
 * the engine's orchestration and edge cases deterministically.
 */
class MockTransport implements DkgTransport {
  shares: string[] = [];
  private store = new Map<string, Quad[]>();
  constructor(private readonly address = '0xMockAuthor') {}
  async agentAddress(): Promise<string> { return this.address; }
  async ensureContextGraph(): Promise<void> {}
  async createAssertion(): Promise<void> {}
  async writeQuads(_cg: string, name: string, quads: Quad[]): Promise<number> {
    this.store.set(name, [...(this.store.get(name) ?? []), ...quads]);
    return quads.length;
  }
  async finalize(): Promise<{ merkleRoot?: string }> { return { merkleRoot: 'm:mock' }; }
  async share(_cg: string, name: string): Promise<void> { this.shares.push(name); }
  async readQuads(_cg: string, name: string): Promise<Quad[]> { return this.store.get(name) ?? []; }
  async getAssetState(): Promise<AssetState> {
    return { memoryLayer: 'SWM', state: 'promoted' };
  }
}

function newEngine(addr = '0xMockAuthor') {
  return new ContestationEngine({
    transport: new MockTransport(addr),
    contextGraphId: `cg-${Math.random()}`,
    reputation: new ReputationLedger(),
  });
}

describe('engine edge cases', () => {
  it('challenge / corroborate / confidence on a non-existent claim throws', async () => {
    const engine = newEngine();
    await expect(
      engine.challenge({ claimId: 'claim:does-not-exist', groundsType: ChallengeGrounds.Contradiction }),
    ).rejects.toThrow(/unknown claim/i);
    await expect(
      engine.corroborate({ claimId: 'claim:nope', independence: Independence.IndependentSource }),
    ).rejects.toThrow(/unknown claim/i);
    expect(() => engine.confidence('claim:nope')).toThrow(/unknown claim/i);
    expect(() => engine.explain('claim:nope')).toThrow(/unknown claim/i);
  });

  it('an uncontested published claim sits at the self-attested floor', async () => {
    const engine = newEngine();
    const claim = await engine.publishClaim({ statement: 'lonely claim' });
    const v = engine.confidence(claim.id);
    expect(v.tier).toBe(ConfidenceTier.SelfAttested);
    expect(v.independentCorroborators).toBe(0);
    expect(v.openChallenges).toBe(0);
  });

  it('a zero-evidence corroboration counts weakly but never lifts to endorsed alone', async () => {
    const engine = newEngine();
    const claim = await engine.publishClaim({ statement: 'thin support' });
    await engine.corroborate({
      claimId: claim.id,
      corroborator: '0xSomeoneElse',
      independence: Independence.IndependentSource,
      // no evidence
    });
    const v = engine.confidence(claim.id);
    // it registers as a corroborator but cannot reach endorsed on a bare nod
    expect(v.tier).toBe(ConfidenceTier.SelfAttested);
  });

  it('self-corroboration by the author is ignored (no influence)', async () => {
    const engine = newEngine('0xAuthorX');
    const claim = await engine.publishClaim({ statement: 'self-back', author: '0xAuthorX' });
    const before = engine.confidence(claim.id).confidence;
    await engine.corroborate({
      claimId: claim.id,
      corroborator: '0xAuthorX', // same as author
      independence: Independence.IndependentSource,
      evidence: [{ id: 'e', kind: EvidenceKind.OnChainFact, source: 's', hash: 'h' }],
    });
    expect(engine.confidence(claim.id).confidence).toBeCloseTo(before);
  });

  it('self-challenge is allowed (acts as retraction) and lowers confidence', async () => {
    const engine = newEngine('0xAuthorY');
    const claim = await engine.publishClaim({ statement: 'i take it back', author: '0xAuthorY' });
    const before = engine.confidence(claim.id).confidence;
    await engine.challenge({
      claimId: claim.id,
      challenger: '0xAuthorY', // author challenges own claim
      groundsType: ChallengeGrounds.Contradiction,
      evidence: [{ id: 'e', kind: EvidenceKind.OnChainFact, source: 's', hash: 'h' }],
    });
    const v = engine.confidence(claim.id);
    expect(v.openChallenges).toBe(1);
    expect(v.confidence).toBeLessThan(before);
  });

  it('an agent with no history is scored at the default cold-start rep', async () => {
    const engine = newEngine();
    expect(engine.reputationOf('0xNeverSeen').rep).toBeCloseTo(0.3);
    expect(engine.reputationOf('0xNeverSeen').samples).toBe(0);
  });

  it('settle does not call endorse when enableEndorse is off (default)', async () => {
    const transport = new MockTransport();
    let endorseCalled = false;
    // augment with an endorse spy
    (transport as unknown as { endorse: () => Promise<void> }).endorse = async () => {
      endorseCalled = true;
    };
    const engine = new ContestationEngine({
      transport,
      contextGraphId: 'cg-endorse',
      reputation: new ReputationLedger(),
      // enableEndorse omitted → defaults false
    });
    const claim = await engine.publishClaim({ statement: 'reach endorsed' });
    // three established corroborators to push to endorsed/consensus
    for (const a of ['0xR1', '0xR2', '0xR3']) {
      await engine.corroborate({
        claimId: claim.id, corroborator: a,
        independence: Independence.IndependentSource,
        evidence: [{ id: `e${a}`, kind: EvidenceKind.OnChainFact, source: `s${a}`, hash: 'h' }],
      });
    }
    await engine.settle(claim.id);
    expect(endorseCalled).toBe(false);
  });
});
