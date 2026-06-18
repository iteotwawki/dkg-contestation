/**
 * The confidence kernel (DESIGN.md §2.2) — the moat.
 *
 * A PURE function of (evidence, agent-diversity, agent-reputation). No I/O, no
 * runtime coupling, no DKG imports. This is deliberate: the exact same kernel
 * that matures a bounty claim is meant to drop into a Bittensor subnet validator
 * as the reward function (DESIGN.md §2.3, §5). Keep it pure and total.
 *
 *   pressure(C) = Σ_corroborations  w_kind · indep(agent) · rep(agent)
 *               − Σ_open_challenges  w_grounds · indep(agent) · rep(agent) · (1 − rebutted)
 *   confidence(C) = anchor c0 at zero pressure, then squash pressure toward
 *                   1 (net support) or 0 (net challenge).
 *
 * Anchoring `c0` at zero pressure (rather than the literal `clamp01(logistic(score))`
 * sketched in DESIGN.md §2.2) makes an *uncontested* claim read exactly the
 * self-attested floor `c0`, which is the behaviour §2.1 actually specifies. The
 * additive evidence/rep/diversity terms are unchanged — only the squash is made
 * c0-anchored so the two halves of the design agree.
 */

import {
  ChallengeGrounds,
  ConfidenceTier,
  EvidenceKind,
  type Independence,
} from './ontology.js';
import type {
  AgentReputation,
  Challenge,
  ContestationGraph,
  Corroboration,
  Evidence,
  Verdict,
} from './types.js';

/** Tunable weights — frozen defaults; a subnet would govern these on-chain. */
export interface ConfidenceParams {
  /** Initial self-attested score before any contestation. */
  c0: number;
  /** Evidence-kind weights (strongest = OnChainFact). */
  wKind: Record<EvidenceKind, number>;
  /** Challenge-grounds weights. */
  wGrounds: Record<ChallengeGrounds, number>;
  /** Logistic steepness. */
  k: number;
  /** Tier thresholds on confidence ∈ [0,1]. */
  endorsedAt: number;
  consensusAt: number;
  /** Min distinct independent corroborators for consensus-verified. */
  consensusMinAgents: number;
  /** Default reputation for an agent we've never seen. */
  defaultRep: number;
  /**
   * Sybil-correlation controls (DESIGN.md §3). Two assertions that cite
   * overlapping evidence sources AND land within `coOccurrenceWindowMs` of each
   * other look like a coordinated swarm rather than independent agreement, so
   * their Jaccard source-overlap is amplified by `coOccurrenceAmplifier` before
   * discounting. `correlationPenalty` scales how hard the worst correlated twin
   * pulls an actor's diversity multiplier down.
   */
  coOccurrenceWindowMs: number;
  coOccurrenceAmplifier: number;
  correlationPenalty: number;
}

export const DEFAULT_PARAMS: ConfidenceParams = {
  c0: 0.3,
  wKind: {
    [EvidenceKind.OnChainFact]: 1.0,
    [EvidenceKind.Replication]: 0.8,
    [EvidenceKind.Measurement]: 0.6,
    [EvidenceKind.Citation]: 0.4,
    [EvidenceKind.Derivation]: 0.25,
  },
  wGrounds: {
    [ChallengeGrounds.Contradiction]: 1.0,
    [ChallengeGrounds.MethodFlaw]: 0.8,
    [ChallengeGrounds.StaleData]: 0.6,
    [ChallengeGrounds.MissingEvidence]: 0.5,
  },
  k: 1.0,
  endorsedAt: 0.6,
  // consensus sits at 0.74 — reachable by ~3 independent strong-evidence
  // corroborators at neutral reputation (pressure≈1.5 → conf≈0.745), yet still
  // well clear of the endorsed line. A higher-reputation cohort clears it
  // comfortably. Tuning this is exactly the kind of parameter a subnet would
  // later govern on-chain (DESIGN.md §2.2).
  consensusAt: 0.74,
  consensusMinAgents: 3,
  defaultRep: 0.5,
  // 5-minute co-occurrence window: independent agents researching the same
  // claim rarely publish within 5 min citing identical sources; a swarm does.
  coOccurrenceWindowMs: 5 * 60_000,
  coOccurrenceAmplifier: 1.5,
  correlationPenalty: 1.0,
};

/** Independence multiplier per corroboration relation. */
const INDEPENDENCE_FACTOR: Record<Independence, number> = {
  IndependentSource: 1.0,
  Replication: 0.85,
  SecondaryConfirm: 0.6,
};

export function logistic(x: number, k = 1): number {
  return 1 / (1 + Math.exp(-k * x));
}

export function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

/** Strongest (max) evidence weight on a contestation; 0 if no evidence. */
function bestEvidenceWeight(
  evidence: Evidence[],
  wKind: Record<EvidenceKind, number>,
): number {
  let best = 0;
  for (const e of evidence) {
    const w = wKind[e.kind] ?? 0;
    if (w > best) best = w;
  }
  return best;
}

/**
 * Diversity discount `indep(agent)` (DESIGN.md §2.2–§3, the anti-gaming core).
 *
 * Upgraded from the binary same-source check to a graded measure with two
 * signals (per operator review, 2026-06-17):
 *
 *   1. Jaccard overlap of evidence sources against every prior accepted
 *      assertion on this claim. Sharing the exact source set another actor
 *      already used is the collusive mutual-corroboration attack; partial
 *      overlap is partially discounted.
 *   2. Temporal co-occurrence: overlap that also lands within
 *      `coOccurrenceWindowMs` of the assertion it overlaps is amplified — a
 *      swarm citing the same sources within minutes is far more suspicious than
 *      two agents independently arriving at the same source days apart.
 *
 * Returns a multiplier in [0,1]: 1 = fully independent, →0 = a correlated twin
 * of evidence already counted. The claim author's own corroborations never
 * count (return 0). `priors` is mutated to append this actor's accepted
 * assertion so later assertions are measured against it.
 */
interface PriorAssertion {
  sources: Set<string>;
  timestampMs: number;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const s of a) if (b.has(s)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function diversityFactor(
  actor: string,
  claimAuthor: string,
  evidence: Evidence[],
  createdAt: string,
  priors: PriorAssertion[],
  params: ConfidenceParams,
): number {
  if (actor.toLowerCase() === claimAuthor.toLowerCase()) return 0;
  if (evidence.length === 0) return 0.5; // assertion with no evidence is weak but non-zero

  const sources = new Set(evidence.map((e) => e.source));
  const tMs = Date.parse(createdAt);
  const t = Number.isNaN(tMs) ? undefined : tMs;

  // Worst-case correlation against any single prior assertion drives the
  // discount: one strong correlated twin is enough to flag coordination.
  let worstCorrelation = 0;
  for (const p of priors) {
    let corr = jaccard(sources, p.sources);
    if (corr === 0) continue;
    const coOccurs =
      t !== undefined &&
      Math.abs(t - p.timestampMs) <= params.coOccurrenceWindowMs;
    if (coOccurs) corr = Math.min(1, corr * params.coOccurrenceAmplifier);
    if (corr > worstCorrelation) worstCorrelation = corr;
  }

  // Record this assertion for future comparisons regardless of its own score.
  priors.push({ sources, timestampMs: t ?? 0 });

  return clamp01(1 - params.correlationPenalty * worstCorrelation);
}

function repOf(
  agent: string,
  reps: Map<string, AgentReputation>,
  fallback: number,
): number {
  return reps.get(agent.toLowerCase())?.rep ?? fallback;
}

/**
 * A challenge is "rebutted" to the degree the claim author answered its grounds.
 * Returns the max rebuttalStrength among rebuttals targeting this challenge.
 */
function rebuttalLevel(
  challenge: Challenge,
  corroborations: Corroboration[],
): number {
  let level = 0;
  for (const c of corroborations) {
    if (c.rebuts === challenge.id) {
      level = Math.max(level, clamp01(c.rebuttalStrength ?? 1));
    }
  }
  return level;
}

/**
 * Compute the confidence verdict for one claim's contestation graph.
 *
 * Pure: same inputs → same output. `reps` is read-only here; updating
 * reputation after a claim settles lives in reputation.ts (separation of
 * concerns — the kernel scores, the ledger learns).
 */
export function computeConfidence(
  graph: ContestationGraph,
  reps: Map<string, AgentReputation> = new Map(),
  params: ConfidenceParams = DEFAULT_PARAMS,
): Verdict {
  const { claim, challenges, corroborations } = graph;
  // Separate diversity trackers: a challenger reinterpreting the same on-chain
  // fact a corroborator cited is legitimate adversarial reuse, NOT sybil
  // correlation. Independence is measured WITHIN the support cohort and WITHIN
  // the challenge cohort, never across them.
  const corroboratorPriors: PriorAssertion[] = [];
  const challengerPriors: PriorAssertion[] = [];

  let pressure = 0;
  const countedCorroborators = new Set<string>();

  // Corroborations push confidence up. Process author-rebuttals separately so a
  // rebuttal doesn't double-count as independent support.
  for (const c of corroborations) {
    if (c.rebuts) continue; // rebuttals act via the (1 − rebutted) term below
    const wKind = bestEvidenceWeight(c.evidence, params.wKind);
    const indep = diversityFactor(
      c.corroborator, claim.author, c.evidence, c.createdAt, corroboratorPriors, params,
    ) * INDEPENDENCE_FACTOR[c.independence];
    const rep = repOf(c.corroborator, reps, params.defaultRep);
    const contribution = wKind * indep * rep;
    if (contribution > 0) {
      pressure += contribution;
      countedCorroborators.add(c.corroborator.toLowerCase());
    }
  }

  // Open challenges pull confidence down, attenuated by how well rebutted.
  let openChallenges = 0;
  for (const ch of challenges) {
    const rebutted = rebuttalLevel(ch, corroborations);
    if (rebutted < 1) openChallenges += 1;
    const wGrounds = params.wGrounds[ch.groundsType] ?? 0.5;
    // A challenge's force scales with its evidence too (a bare assertion of
    // doubt is weaker than one carrying a contradicting on-chain fact).
    const evWeight = ch.evidence.length > 0
      ? bestEvidenceWeight(ch.evidence, params.wKind)
      : 0.5;
    const indep = diversityFactor(
      ch.challenger, claim.author, ch.evidence, ch.createdAt, challengerPriors, params,
    );
    const rep = repOf(ch.challenger, reps, params.defaultRep);
    pressure -= wGrounds * evWeight * indep * rep * (1 - rebutted);
  }

  // c0-anchored squash: zero pressure → exactly c0; net support → toward 1;
  // net challenge → toward 0. logistic maps pressure to (0,1); we rescale each
  // half so the curve passes through (0, c0) continuously.
  const half = logistic(params.k * pressure) - 0.5; // ∈ (-0.5, 0.5)
  const confidence = clamp01(
    half >= 0
      ? params.c0 + 2 * half * (1 - params.c0)
      : params.c0 + 2 * half * params.c0,
  );
  const score = params.c0 + pressure;
  const independentCorroborators = countedCorroborators.size;
  const tier = classifyTier(
    confidence,
    independentCorroborators,
    openChallenges,
    params,
  );

  return {
    claimId: claim.id,
    score,
    confidence,
    tier,
    independentCorroborators,
    openChallenges,
  };
}

export function classifyTier(
  confidence: number,
  independentCorroborators: number,
  openChallenges: number,
  params: ConfidenceParams = DEFAULT_PARAMS,
): ConfidenceTier {
  if (
    confidence >= params.consensusAt &&
    independentCorroborators >= params.consensusMinAgents &&
    openChallenges === 0
  ) {
    return ConfidenceTier.ConsensusVerified;
  }
  if (
    confidence >= params.endorsedAt &&
    independentCorroborators >= 1 &&
    openChallenges === 0
  ) {
    return ConfidenceTier.Endorsed;
  }
  return ConfidenceTier.SelfAttested;
}
