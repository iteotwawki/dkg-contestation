/**
 * The `ct:` contestation ontology.
 *
 * A single source of truth for every IRI the protocol emits. The DESIGN.md
 * assertion shapes (Claim / Challenge / Corroboration / Evidence) are expressed
 * here as constants so the writers, the confidence engine, and the read layer
 * never disagree on a predicate string.
 *
 * Namespace is overridable at construction time (DESIGN.md open decision #3) so
 * we can align to an OriginTrail-preferred IRI without touching call sites.
 */

export const DEFAULT_CT_NAMESPACE = 'https://contestation.dkg/ontology#';
export const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
export const XSD = 'http://www.w3.org/2001/XMLSchema#';

/** Grounds on which a challenger disputes a claim. */
export const ChallengeGrounds = {
  Contradiction: 'Contradiction',
  MissingEvidence: 'MissingEvidence',
  StaleData: 'StaleData',
  MethodFlaw: 'MethodFlaw',
} as const;
export type ChallengeGrounds =
  (typeof ChallengeGrounds)[keyof typeof ChallengeGrounds];

/** How a corroboration relates to the claim it supports. */
export const Independence = {
  IndependentSource: 'IndependentSource',
  Replication: 'Replication',
  SecondaryConfirm: 'SecondaryConfirm',
} as const;
export type Independence =
  (typeof Independence)[keyof typeof Independence];

/** Evidence kinds, ordered weakest→strongest in §2.2 weighting. */
export const EvidenceKind = {
  Derivation: 'Derivation',
  Citation: 'Citation',
  Measurement: 'Measurement',
  Replication: 'Replication',
  OnChainFact: 'OnChainFact',
} as const;
export type EvidenceKind =
  (typeof EvidenceKind)[keyof typeof EvidenceKind];

/** Confidence tiers along v10's trust gradient. */
export const ConfidenceTier = {
  SelfAttested: 'self-attested',
  Endorsed: 'endorsed',
  ConsensusVerified: 'consensus-verified',
} as const;
export type ConfidenceTier =
  (typeof ConfidenceTier)[keyof typeof ConfidenceTier];

/**
 * Vocabulary bound to a concrete namespace. Construct once, share everywhere.
 */
export class Ontology {
  readonly ns: string;

  constructor(namespace: string = DEFAULT_CT_NAMESPACE) {
    // Normalise: ensure it ends in a fragment/path separator so term() is a
    // plain concatenation.
    this.ns = namespace.endsWith('#') || namespace.endsWith('/')
      ? namespace
      : `${namespace}#`;
  }

  /** Resolve a local name to a full IRI in the ct: namespace. */
  term(localName: string): string {
    return `${this.ns}${localName}`;
  }

  // --- Classes ---
  get Claim(): string { return this.term('Claim'); }
  get Challenge(): string { return this.term('Challenge'); }
  get Corroboration(): string { return this.term('Corroboration'); }
  get Evidence(): string { return this.term('Evidence'); }

  // --- Claim predicates ---
  get statement(): string { return this.term('statement'); }
  get author(): string { return this.term('author'); }
  get confidence(): string { return this.term('confidence'); }
  get tier(): string { return this.term('tier'); }
  get merkleRoot(): string { return this.term('merkleRoot'); }

  // --- Challenge predicates ---
  get targets(): string { return this.term('targets'); }
  get challenger(): string { return this.term('challenger'); }
  get groundsType(): string { return this.term('groundsType'); }
  get stake(): string { return this.term('stake'); }

  // --- Corroboration predicates ---
  get supports(): string { return this.term('supports'); }
  get corroborator(): string { return this.term('corroborator'); }
  get independence(): string { return this.term('independence'); }

  // --- Shared predicates ---
  get evidence(): string { return this.term('evidence'); }
  get createdAt(): string { return this.term('createdAt'); }
  get rebuts(): string { return this.term('rebuts'); }

  // --- Evidence predicates ---
  get kind(): string { return this.term('kind'); }
  get source(): string { return this.term('source'); }
  get hash(): string { return this.term('hash'); }

  /** Full IRI for an enum member (e.g. EvidenceKind.OnChainFact). */
  enum(localName: string): string {
    return this.term(localName);
  }
}
