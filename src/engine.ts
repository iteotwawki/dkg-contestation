/**
 * The contestation engine — orchestrates the lifecycle.
 *
 * Ties together: transport (DKG I/O) + serializers (struct→quad) + the pure
 * confidence kernel + the reputation ledger. This is the object an agent client
 * (Hermes/OpenClaw/any) drives. The five verbs map 1:1 to the DESIGN.md client
 * contract: claim · challenge · corroborate · read · settle.
 *
 * Persistence note: the canonical record lives in DKG Shared Memory (every
 * assertion is written + shared). The in-memory `graphs` map is a local index
 * for fast confidence recomputation; it can be rebuilt from SWM by reading the
 * claim's context graph. The MVP keeps the index in-process.
 */

import { randomUUID } from 'node:crypto';
import {
  computeConfidence,
  explainConfidence,
  DEFAULT_PARAMS,
  type ConfidenceParams,
} from './confidence.js';
import { Ontology, ConfidenceTier } from './ontology.js';
import { ReputationLedger } from './reputation.js';
import {
  challengeToQuads,
  claimToQuads,
  corroborationToQuads,
} from './serialize.js';
import type { DkgTransport } from './transport.js';
import type {
  Challenge,
  Claim,
  ContestationGraph,
  Corroboration,
  Evidence,
  Verdict,
  ConfidenceExplanation,
} from './types.js';
import type {
  ChallengeGrounds,
  Independence,
} from './ontology.js';

export interface EngineOptions {
  transport: DkgTransport;
  contextGraphId: string;
  ontology?: Ontology;
  confidenceParams?: ConfidenceParams;
  reputation?: ReputationLedger;
  /**
   * Opt in to calling the node's `/api/endorse` primitive when a claim reaches
   * the endorsed/consensus tier. Default `false`: the protocol is Working/Shared
   * memory only, with no curator-authority endorse/verify writes. Endorsement is
   * a separate, operator-gated capability — turn this on only when your node and
   * scope permit it.
   */
  enableEndorse?: boolean;
  /** Clock injection for deterministic tests. */
  now?: () => string;
  /** ID generator injection for deterministic tests. */
  newId?: (prefix: string) => string;
}

export interface PublishClaimInput {
  statement: string;
  /** Defaults to the transport's agent address. */
  author?: string;
  id?: string;
}

export interface ChallengeInput {
  claimId: string;
  challenger?: string;
  groundsType: ChallengeGrounds;
  evidence?: Evidence[];
  stake?: number;
}

export interface CorroborateInput {
  claimId: string;
  corroborator?: string;
  independence: Independence;
  evidence?: Evidence[];
  /** Set when this is the claim author rebutting a specific challenge. */
  rebuts?: string;
  rebuttalStrength?: number;
}

export class ContestationEngine {
  private readonly t: DkgTransport;
  private readonly cgId: string;
  private readonly o: Ontology;
  private readonly params: ConfidenceParams;
  private readonly reputation: ReputationLedger;
  private readonly enableEndorse: boolean;
  private readonly now: () => string;
  private readonly newId: (prefix: string) => string;
  private readonly graphs = new Map<string, ContestationGraph>();
  private ready = false;

  constructor(opts: EngineOptions) {
    this.t = opts.transport;
    this.cgId = opts.contextGraphId;
    this.o = opts.ontology ?? new Ontology();
    this.params = opts.confidenceParams ?? DEFAULT_PARAMS;
    this.reputation = opts.reputation ?? new ReputationLedger();
    this.enableEndorse = opts.enableEndorse ?? false;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.newId = opts.newId ?? ((p) => `${p}:${randomUUID()}`);
  }

  /** Ensure the context graph exists. Safe to call repeatedly. */
  async init(): Promise<void> {
    if (this.ready) return;
    await this.t.ensureContextGraph(this.cgId, 'Contestation');
    this.ready = true;
  }

  /** Write + finalize + share one assertion to SWM under a unique KA name. */
  private async writeShared(kaName: string, quads: ReturnType<typeof claimToQuads>): Promise<void> {
    await this.t.createAssertion(this.cgId, kaName);
    await this.t.writeQuads(this.cgId, kaName, quads);
    // finalize seals; share promotes to SWM. finalize can fail on capability
    // gaps (no signer) — tolerate that in the MVP and still share so the data
    // is team-visible.
    try {
      await this.t.finalize(this.cgId, kaName);
    } catch {
      /* unsealed share is acceptable for the free WM/SWM MVP */
    }
    await this.t.share(this.cgId, kaName);
  }

  /** Deterministic-ish KA name from an assertion id. */
  private kaName(id: string): string {
    return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  }

  /** Publish a new Claim (roadmap step 1: a finding enters contested memory). */
  async publishClaim(input: PublishClaimInput): Promise<Claim> {
    await this.init();
    const author = input.author ?? (await this.t.agentAddress());
    const claim: Claim = {
      id: input.id ?? this.newId('claim'),
      statement: input.statement,
      author,
      createdAt: this.now(),
    };
    const seal = await (async () => {
      const kaName = this.kaName(claim.id);
      await this.t.createAssertion(this.cgId, kaName);
      await this.t.writeQuads(this.cgId, kaName, claimToQuads(this.o, claim));
      try {
        return await this.t.finalize(this.cgId, kaName);
      } catch {
        return {};
      } finally {
        await this.t.share(this.cgId, kaName);
      }
    })();
    if (seal.merkleRoot) claim.merkleRoot = seal.merkleRoot;
    this.graphs.set(claim.id, { claim, challenges: [], corroborations: [] });
    return claim;
  }

  /** Challenge an existing claim. */
  async challenge(input: ChallengeInput): Promise<Challenge> {
    await this.init();
    const graph = this.requireGraph(input.claimId);
    const challenger = input.challenger ?? (await this.t.agentAddress());
    const challenge: Challenge = {
      id: this.newId('challenge'),
      targets: input.claimId,
      challenger,
      groundsType: input.groundsType,
      evidence: input.evidence ?? [],
      ...(input.stake !== undefined ? { stake: input.stake } : {}),
      createdAt: this.now(),
    };
    await this.writeShared(this.kaName(challenge.id), challengeToQuads(this.o, challenge));
    graph.challenges.push(challenge);
    return challenge;
  }

  /** Corroborate (or, with `rebuts`, rebut a challenge to) a claim. */
  async corroborate(input: CorroborateInput): Promise<Corroboration> {
    await this.init();
    const graph = this.requireGraph(input.claimId);
    const corroborator = input.corroborator ?? (await this.t.agentAddress());
    const corroboration: Corroboration = {
      id: this.newId('corroboration'),
      supports: input.claimId,
      corroborator,
      independence: input.independence,
      evidence: input.evidence ?? [],
      createdAt: this.now(),
      ...(input.rebuts ? { rebuts: input.rebuts } : {}),
      ...(input.rebuttalStrength !== undefined ? { rebuttalStrength: input.rebuttalStrength } : {}),
    };
    await this.writeShared(this.kaName(corroboration.id), corroborationToQuads(this.o, corroboration));
    graph.corroborations.push(corroboration);
    return corroboration;
  }

  /** Current confidence verdict for a claim (recomputed from the live graph). */
  confidence(claimId: string): Verdict {
    const graph = this.requireGraph(claimId);
    return computeConfidence(graph, this.reputation.view(), this.params);
  }

  /**
   * Confidence verdict PLUS a per-assertion contribution breakdown — why the
   * claim has its current score. Observability for debugging and the TAO-loop
   * demo. Same math as confidence(); this just also returns the breakdown.
   */
  explain(claimId: string): ConfidenceExplanation {
    const graph = this.requireGraph(claimId);
    return explainConfidence(graph, this.reputation.view(), this.params);
  }

  /** The full contestation graph around a claim. */
  read(claimId: string): ContestationGraph {
    return this.requireGraph(claimId);
  }

  /**
   * Settle a claim: compute the final verdict, fold it into reputations, and
   * (if it reached endorsed/consensus) endorse it on the node. Returns the
   * settling verdict.
   */
  async settle(claimId: string): Promise<Verdict> {
    const graph = this.requireGraph(claimId);
    const verdict = computeConfidence(graph, this.reputation.view(), this.params);
    this.reputation.settle(graph, verdict);
    if (
      this.enableEndorse &&
      (verdict.tier === ConfidenceTier.Endorsed ||
        verdict.tier === ConfidenceTier.ConsensusVerified) &&
      this.t.endorse
    ) {
      try {
        await this.t.endorse(this.cgId, this.kaName(claimId));
      } catch {
        /* endorse is best-effort in the MVP */
      }
    }
    return verdict;
  }

  /** Reputation snapshot (the would-be subnet score vector). */
  reputationOf(agent: string) {
    return this.reputation.get(agent);
  }

  private requireGraph(claimId: string): ContestationGraph {
    const g = this.graphs.get(claimId);
    if (!g) throw new Error(`Unknown claim: ${claimId}. publishClaim first.`);
    return g;
  }
}
