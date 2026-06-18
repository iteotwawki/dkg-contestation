/**
 * Core domain types for the contestation protocol.
 *
 * These are the framework-agnostic data shapes. Nothing here imports Hermes,
 * OpenClaw, or any runtime — a client is anything that can move these structs
 * over the DKG HTTP API (see DkgTransport in transport.ts).
 */

import type {
  ChallengeGrounds,
  ConfidenceTier,
  EvidenceKind,
  Independence,
} from './ontology.js';

/** An RDF quad in the shape the DKG `wm/write` API accepts. */
export interface Quad {
  subject: string;
  predicate: string;
  /** N-Triples object: IRI as-is, or a quoted literal `"..."`. */
  object: string;
}

/** Evidence attached to a challenge or corroboration. */
export interface Evidence {
  id: string;
  kind: EvidenceKind;
  /** URL / UAL / tx hash / dataset id. */
  source: string;
  /** Content hash for tamper-evidence. */
  hash: string;
}

/** A knowledge claim — the thing that gets contested. */
export interface Claim {
  /** Stable id (becomes the subject IRI). Often the assertion URI / UAL. */
  id: string;
  statement: string;
  /** Author agent address (0x...). */
  author: string;
  /** DKG seal root from /wm/finalize, when available. */
  merkleRoot?: string;
  createdAt: string;
}

/** A challenge disputing a claim. */
export interface Challenge {
  id: string;
  /** Claim id this targets. */
  targets: string;
  challenger: string;
  groundsType: ChallengeGrounds;
  evidence: Evidence[];
  /** Optional confidence the challenger puts at risk. */
  stake?: number;
  createdAt: string;
}

/** A corroboration supporting a claim. */
export interface Corroboration {
  id: string;
  /** Claim id this supports. */
  supports: string;
  corroborator: string;
  independence: Independence;
  evidence: Evidence[];
  createdAt: string;
  /**
   * If set, this corroboration is a REBUTTAL authored by the claim author that
   * answers a specific challenge. `rebuts` is the challenge id; `rebuttalStrength`
   * ∈ [0,1] is how completely it addresses that challenge's grounds.
   */
  rebuts?: string;
  rebuttalStrength?: number;
}

/** The full contestation graph around one claim. */
export interface ContestationGraph {
  claim: Claim;
  challenges: Challenge[];
  corroborations: Corroboration[];
}

/** A settled or in-progress confidence verdict for a claim. */
export interface Verdict {
  claimId: string;
  /** Raw additive score before squashing. */
  score: number;
  /** confidence ∈ [0,1] after the logistic squash. */
  confidence: number;
  tier: ConfidenceTier;
  /** Number of distinct, independent corroborators that counted. */
  independentCorroborators: number;
  /** Open (unrebutted) challenges remaining. */
  openChallenges: number;
}

/** Reputation snapshot for one agent (the would-be subnet score). */
export interface AgentReputation {
  agent: string;
  /** rep ∈ [0,1], EWMA over settled contestation outcomes. */
  rep: number;
  /** Count of settled assertions that fed the EWMA. */
  samples: number;
}
