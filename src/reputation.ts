/**
 * Reputation ledger — turns settled contestation outcomes into `rep(agent)`.
 *
 * Separated from the confidence kernel on purpose: the kernel SCORES a claim
 * (pure), the ledger LEARNS from settled claims (stateful EWMA). In the subnet
 * endgame (DESIGN.md §5) this ledger's `rep` map IS the validator's scoring
 * vector — so it stays a clean, inspectable function of observed outcomes.
 *
 * Outcome signal per settled claim:
 *   - a corroborator is REWARDED if the claim it supported settled at/above the
 *     endorsed line, PENALISED if the claim collapsed (self-attested with open
 *     challenges).
 *   - a challenger is REWARDED if the claim it challenged collapsed, PENALISED
 *     if the claim it challenged survived to endorsed/consensus.
 * "Did your judgement survive scrutiny?" — symmetric for support and dissent.
 */

import { ConfidenceTier } from './ontology.js';
import type {
  AgentReputation,
  ContestationGraph,
  Verdict,
} from './types.js';

export interface ReputationParams {
  /** EWMA smoothing factor α ∈ (0,1]; higher = faster to move. */
  alpha: number;
  /** Starting reputation for a never-seen agent. */
  initialRep: number;
}

export const DEFAULT_REPUTATION_PARAMS: ReputationParams = {
  alpha: 0.2,
  initialRep: 0.5,
};

export class ReputationLedger {
  private readonly reps = new Map<string, AgentReputation>();
  private readonly params: ReputationParams;

  constructor(params: ReputationParams = DEFAULT_REPUTATION_PARAMS) {
    this.params = params;
  }

  /** Read-only snapshot for the confidence kernel. */
  view(): Map<string, AgentReputation> {
    return new Map(this.reps);
  }

  get(agent: string): AgentReputation {
    return (
      this.reps.get(agent.toLowerCase()) ?? {
        agent,
        rep: this.params.initialRep,
        samples: 0,
      }
    );
  }

  /** EWMA update toward `target` ∈ [0,1] for one agent. */
  private observe(agent: string, target: number): void {
    const key = agent.toLowerCase();
    const prev = this.reps.get(key) ?? {
      agent,
      rep: this.params.initialRep,
      samples: 0,
    };
    const rep = prev.rep + this.params.alpha * (target - prev.rep);
    this.reps.set(key, { agent, rep, samples: prev.samples + 1 });
  }

  /**
   * Fold a SETTLED claim's verdict back into reputations. Call once per claim
   * when its contestation window closes.
   */
  settle(graph: ContestationGraph, verdict: Verdict): void {
    const survived =
      verdict.tier === ConfidenceTier.Endorsed ||
      verdict.tier === ConfidenceTier.ConsensusVerified;
    const collapsed =
      verdict.tier === ConfidenceTier.SelfAttested &&
      verdict.openChallenges > 0;

    // Corroborators: rewarded when the claim survived.
    for (const c of graph.corroborations) {
      if (c.rebuts) continue; // rebuttals scored via their authorship of the claim
      if (survived) this.observe(c.corroborator, 1);
      else if (collapsed) this.observe(c.corroborator, 0);
    }

    // Challengers: rewarded when the claim collapsed.
    for (const ch of graph.challenges) {
      if (collapsed) this.observe(ch.challenger, 1);
      else if (survived) this.observe(ch.challenger, 0);
    }

    // The claim author: rewarded if their own claim survived, penalised if it
    // collapsed. This is the core "truth-seeking" incentive.
    if (survived) this.observe(graph.claim.author, 1);
    else if (collapsed) this.observe(graph.claim.author, 0);
  }
}
