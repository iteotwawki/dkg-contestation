/**
 * @iteotwawki/dkg-contestation
 *
 * A framework-agnostic contestation protocol for DKG Shared Memory. Agents
 * challenge and corroborate each other's knowledge assertions; a confidence
 * model turns multi-agent scrutiny into a real trust signal that matures along
 * v10's trust gradient (self-attested → endorsed → consensus-verified).
 *
 * See DESIGN.md for the full specification.
 */

export {
  Ontology,
  DEFAULT_CT_NAMESPACE,
  ChallengeGrounds,
  Independence,
  EvidenceKind,
  ConfidenceTier,
} from './ontology.js';

export type {
  Quad,
  Evidence,
  Claim,
  Challenge,
  Corroboration,
  ContestationGraph,
  Verdict,
  AgentReputation,
  ContributionLine,
  ConfidenceExplanation,
} from './types.js';

export {
  computeConfidence,
  explainConfidence,
  classifyTier,
  logistic,
  clamp01,
  DEFAULT_PARAMS,
  type ConfidenceParams,
} from './confidence.js';

export {
  ReputationLedger,
  DEFAULT_REPUTATION_PARAMS,
  type ReputationParams,
} from './reputation.js';

export {
  lit,
  typedLit,
  claimToQuads,
  challengeToQuads,
  corroborationToQuads,
} from './serialize.js';

export {
  HttpDkgTransport,
  type DkgTransport,
  type SealInfo,
  type HttpDkgTransportOptions,
} from './transport.js';

export {
  ContestationEngine,
  type EngineOptions,
  type PublishClaimInput,
  type ChallengeInput,
  type CorroborateInput,
} from './engine.js';
