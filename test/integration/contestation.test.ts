/**
 * Integration test — full contestation round against a LIVE local DKG node.
 *
 * Skips automatically unless a node is reachable at DKG_API_URL (default
 * http://127.0.0.1:9200) with DKG_HOME set so the auth token can be discovered.
 * This exercises the real rc.17 HTTP API end-to-end: create CG → publish claim
 * (write/finalize/share) → challenge → corroborate → read back from SWM.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { HttpDkgTransport } from '../../src/transport.js';
import { ContestationEngine } from '../../src/engine.js';
import { ReputationLedger } from '../../src/reputation.js';
import {
  ChallengeGrounds,
  ConfidenceTier,
  EvidenceKind,
  Independence,
} from '../../src/ontology.js';

const BASE = process.env.DKG_API_URL ?? 'http://127.0.0.1:9200';
const DKG_HOME = process.env.DKG_HOME ?? '/home/hermes/origintrail/.dkg-node';

// One CG id, created once in beforeAll (slow, sync-coupled) and reused by the
// timed test body so we measure protocol behaviour, not first-touch sync.
const WARM_CG = `contestation-it-${Date.now()}`;

async function nodeUp(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/api/status`, { signal: AbortSignal.timeout(2500) });
    return res.ok;
  } catch {
    return false;
  }
}

describe('integration: contestation over a live DKG node', () => {
  let up = false;
  beforeAll(async () => {
    up = await nodeUp();
    if (!up) {
      console.warn(`[integration] no DKG node at ${BASE} — skipping live tests`);
      return;
    }
    // Pre-warm: a DKG v10 node couples context-graph creation to P2P sync, so
    // the FIRST ensureContextGraph against a freshly-discovered CG can take
    // ~10–15s on a syncing node. Do it once here, outside the timed assertion,
    // so the round-trip test measures the protocol — not testnet sync latency.
    try {
      const warm = new HttpDkgTransport({ baseUrl: BASE, dkgHome: DKG_HOME, timeoutMs: 60_000 });
      await warm.ensureContextGraph(WARM_CG, 'Contestation warm-up');
    } catch (err) {
      console.warn(`[integration] pre-warm failed (continuing): ${(err as Error).message}`);
    }
  }, 90_000);

  it('runs a full claim → challenge → corroborate → read round', async () => {
    if (!up) return; // soft-skip when no node

    const transport = new HttpDkgTransport({ baseUrl: BASE, dkgHome: DKG_HOME, timeoutMs: 60_000 });
    const author = await transport.agentAddress();
    expect(author).toMatch(/^0x/);

    const cgId = WARM_CG;
    const engine = new ContestationEngine({
      transport,
      contextGraphId: cgId,
      reputation: new ReputationLedger(),
    });

    // 1. publish a claim
    const claim = await engine.publishClaim({
      statement: 'Integration test claim: contestation round-trips over HTTP.',
    });
    expect(claim.id).toContain('claim:');

    // an uncontested claim sits at the self-attested floor
    let v = engine.confidence(claim.id);
    expect(v.tier).toBe(ConfidenceTier.SelfAttested);

    // 2. another agent (simulated by address override) corroborates with on-chain evidence
    await engine.corroborate({
      claimId: claim.id,
      corroborator: '0xCorroboratorA',
      independence: Independence.IndependentSource,
      evidence: [{ id: 'ev:a', kind: EvidenceKind.OnChainFact, source: 'tx:0xfeed', hash: 'h:a' }],
    });

    v = engine.confidence(claim.id);
    expect(v.confidence).toBeGreaterThan(0.3);
    expect(v.independentCorroborators).toBe(1);

    // 3. a challenge is raised
    const challenge = await engine.challenge({
      claimId: claim.id,
      challenger: '0xSkeptic',
      groundsType: ChallengeGrounds.MissingEvidence,
      evidence: [{ id: 'ev:c', kind: EvidenceKind.Citation, source: 'doc:doubt', hash: 'h:c' }],
    });
    v = engine.confidence(claim.id);
    expect(v.openChallenges).toBe(1);

    // 4. author rebuts the challenge
    await engine.corroborate({
      claimId: claim.id,
      corroborator: author,
      independence: Independence.SecondaryConfirm,
      rebuts: challenge.id,
      rebuttalStrength: 1,
      evidence: [{ id: 'ev:r', kind: EvidenceKind.Measurement, source: 'measure:1', hash: 'h:r' }],
    });
    v = engine.confidence(claim.id);
    expect(v.openChallenges).toBe(0);

    // 5. prove the claim persisted and was promoted to shared memory.
    //    NOTE: after swm/share the node promotes WM→SWM (emptying the WM draft),
    //    and the literal data triples only become SPARQL-queryable after on-chain
    //    CG registration + cross-node durable sync — which costs gas and is
    //    deferred under the no-spend doctrine. The free, local, real property we
    //    CAN prove is that the assertion reached SWM. (DESIGN.md §4: durable
    //    read-back is the on-chain promotion path, gated behind consensus.)
    const kaName = claim.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
    const state = await transport.getAssetState(cgId, kaName);
    expect(state.memoryLayer).toBe('SWM');
    expect(state.state).toBe('promoted');

    // 6. settle — folds outcomes into reputation
    const final = await engine.settle(claim.id);
    expect([ConfidenceTier.Endorsed, ConfidenceTier.SelfAttested, ConfidenceTier.ConsensusVerified])
      .toContain(final.tier);
  }, 120_000);
});
