/**
 * Serializers: domain structs ⇄ DKG quads.
 *
 * The DKG `wm/write` API takes `{subject, predicate, object}` triples where the
 * object is either an IRI or an N-Triples literal `"..."`. These functions are
 * the only place that knows the wire shape, so the engine and client stay clean.
 */

import { Ontology, RDF_TYPE, XSD } from './ontology.js';
import type {
  Challenge,
  Claim,
  Corroboration,
  Evidence,
  Quad,
} from './types.js';

/** N-Triples-quote a string literal (escapes \, ", newlines, tabs). */
export function lit(value: string): string {
  const esc = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${esc}"`;
}

/** Typed literal, e.g. a number as xsd:decimal. */
export function typedLit(value: string, datatypeIri: string): string {
  return `${lit(value)}^^${datatypeIri}`;
}

function evidenceQuads(o: Ontology, parentId: string, evidence: Evidence[]): Quad[] {
  const quads: Quad[] = [];
  for (const e of evidence) {
    quads.push(
      { subject: e.id, predicate: RDF_TYPE, object: o.Evidence },
      { subject: e.id, predicate: o.kind, object: o.enum(e.kind) },
      { subject: e.id, predicate: o.source, object: lit(e.source) },
      { subject: e.id, predicate: o.hash, object: lit(e.hash) },
      { subject: parentId, predicate: o.evidence, object: e.id },
    );
  }
  return quads;
}

export function claimToQuads(o: Ontology, claim: Claim): Quad[] {
  const quads: Quad[] = [
    { subject: claim.id, predicate: RDF_TYPE, object: o.Claim },
    { subject: claim.id, predicate: o.statement, object: lit(claim.statement) },
    { subject: claim.id, predicate: o.author, object: lit(claim.author) },
    { subject: claim.id, predicate: o.createdAt, object: lit(claim.createdAt) },
  ];
  if (claim.merkleRoot) {
    quads.push({ subject: claim.id, predicate: o.merkleRoot, object: lit(claim.merkleRoot) });
  }
  return quads;
}

export function challengeToQuads(o: Ontology, ch: Challenge): Quad[] {
  const quads: Quad[] = [
    { subject: ch.id, predicate: RDF_TYPE, object: o.Challenge },
    { subject: ch.id, predicate: o.targets, object: ch.targets },
    { subject: ch.id, predicate: o.challenger, object: lit(ch.challenger) },
    { subject: ch.id, predicate: o.groundsType, object: o.enum(ch.groundsType) },
    { subject: ch.id, predicate: o.createdAt, object: lit(ch.createdAt) },
  ];
  if (ch.stake !== undefined) {
    quads.push({ subject: ch.id, predicate: o.stake, object: typedLit(String(ch.stake), `${XSD}decimal`) });
  }
  return [...quads, ...evidenceQuads(o, ch.id, ch.evidence)];
}

export function corroborationToQuads(o: Ontology, c: Corroboration): Quad[] {
  const quads: Quad[] = [
    { subject: c.id, predicate: RDF_TYPE, object: o.Corroboration },
    { subject: c.id, predicate: o.supports, object: c.supports },
    { subject: c.id, predicate: o.corroborator, object: lit(c.corroborator) },
    { subject: c.id, predicate: o.independence, object: o.enum(c.independence) },
    { subject: c.id, predicate: o.createdAt, object: lit(c.createdAt) },
  ];
  if (c.rebuts) {
    quads.push({ subject: c.id, predicate: o.rebuts, object: c.rebuts });
    if (c.rebuttalStrength !== undefined) {
      quads.push({
        subject: c.id,
        predicate: o.term('rebuttalStrength'),
        object: typedLit(String(c.rebuttalStrength), `${XSD}decimal`),
      });
    }
  }
  return [...quads, ...evidenceQuads(o, c.id, c.evidence)];
}
