#!/usr/bin/env node
/**
 * dkg-contest — CLI surface for the DKG contestation protocol.
 *
 * Three commands, each honest about what it needs:
 *
 *   dkg-contest score   [file]   Pure confidence kernel. Reads a ContestationGraph
 *                                JSON from a file or stdin, prints the verdict.
 *                                NO node required — this is the moat, runnable offline.
 *
 *   dkg-contest demo             Full contestation round against a live DKG node:
 *                                claim → corroborate → challenge → rebut → settle,
 *                                printing how confidence/tier evolve. Proves the
 *                                protocol end-to-end over HTTP. Needs DKG_API_URL +
 *                                DKG_AUTH_TOKEN (auto-filled by `dkg integration install`).
 *
 *   dkg-contest claim "<text>"   Publish one claim to the DKG and print its id + verdict.
 *
 * Framework-agnostic by construction: `score` speaks plain JSON on stdin/stdout, so
 * any agent in any language can pipe a contestation graph and get a trust signal back.
 */

import { readFileSync } from 'node:fs';
import { computeConfidence } from './confidence.js';
import { ReputationLedger } from './reputation.js';
import { HttpDkgTransport } from './transport.js';
import { ContestationEngine } from './engine.js';
import {
  ChallengeGrounds,
  ConfidenceTier,
  EvidenceKind,
  Independence,
} from './ontology.js';
import type { ContestationGraph, Verdict } from './types.js';

function die(msg: string, code = 1): never {
  process.stderr.write(`dkg-contest: ${msg}\n`);
  process.exit(code);
}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function fmtVerdict(v: Verdict): string {
  return JSON.stringify(v, null, 2);
}

function transportFromEnv(): HttpDkgTransport {
  const baseUrl = process.env.DKG_API_URL ?? 'http://127.0.0.1:9200';
  const dkgHome = process.env.DKG_HOME;
  const authToken = process.env.DKG_AUTH_TOKEN;
  if (!authToken && !dkgHome) {
    die(
      'need a node token: set DKG_AUTH_TOKEN (or DKG_HOME so the token can be discovered).\n' +
        'For offline scoring that needs no node, use: dkg-contest score <graph.json>',
    );
  }
  return new HttpDkgTransport({ baseUrl, authToken, dkgHome, timeoutMs: 60_000 });
}

/** `score` — pure kernel over a ContestationGraph JSON. No node needed. */
function cmdScore(args: string[]): void {
  const file = args[0];
  const raw = file ? readFileSync(file, 'utf8') : readStdin();
  if (!raw.trim()) {
    die('no input. Pass a ContestationGraph JSON file or pipe it on stdin.\n' +
      'Example: echo \'{"claim":{...},"challenges":[],"corroborations":[]}\' | dkg-contest score');
  }
  let graph: ContestationGraph;
  try {
    graph = JSON.parse(raw) as ContestationGraph;
  } catch (err) {
    die(`invalid JSON: ${(err as Error).message}`);
  }
  if (!graph.claim) die('input has no "claim" — not a ContestationGraph.');
  graph.challenges ??= [];
  graph.corroborations ??= [];
  const verdict = computeConfidence(graph);
  process.stdout.write(fmtVerdict(verdict) + '\n');
}

/** `demo` — full live round, prints confidence at each step. */
async function cmdDemo(): Promise<void> {
  const transport = transportFromEnv();
  const author = await transport.agentAddress();
  const cgId = `contestation-demo-${Date.now()}`;
  const engine = new ContestationEngine({
    transport,
    contextGraphId: cgId,
    reputation: new ReputationLedger(),
  });

  const log = (label: string, v: Verdict) =>
    process.stdout.write(
      `${label.padEnd(28)} conf=${v.confidence.toFixed(3)}  tier=${v.tier}  ` +
        `corroborators=${v.independentCorroborators}  openChallenges=${v.openChallenges}\n`,
    );

  process.stdout.write(`# contestation demo against ${process.env.DKG_API_URL ?? 'http://127.0.0.1:9200'}\n`);
  process.stdout.write(`# author=${author}  contextGraph=${cgId}\n\n`);

  const claim = await engine.publishClaim({
    statement: 'Demo claim: confidence emerges from surviving contestation.',
  });
  log('1. published (self-attested)', engine.confidence(claim.id));

  await engine.corroborate({
    claimId: claim.id,
    corroborator: '0xCorroboratorA',
    independence: Independence.IndependentSource,
    evidence: [{ id: 'ev:a', kind: EvidenceKind.OnChainFact, source: 'tx:0xfeed', hash: 'h:a' }],
  });
  log('2. corroborated (on-chain)', engine.confidence(claim.id));

  const challenge = await engine.challenge({
    claimId: claim.id,
    challenger: '0xSkeptic',
    groundsType: ChallengeGrounds.MissingEvidence,
    evidence: [{ id: 'ev:c', kind: EvidenceKind.Citation, source: 'doc:doubt', hash: 'h:c' }],
  });
  log('3. challenged', engine.confidence(claim.id));

  await engine.corroborate({
    claimId: claim.id,
    corroborator: author,
    independence: Independence.SecondaryConfirm,
    rebuts: challenge.id,
    rebuttalStrength: 1,
    evidence: [{ id: 'ev:r', kind: EvidenceKind.Measurement, source: 'measure:1', hash: 'h:r' }],
  });
  log('4. rebutted', engine.confidence(claim.id));

  const final = await engine.settle(claim.id);
  process.stdout.write('\n');
  log('5. settled', final);
  process.stdout.write(`\n# claim id: ${claim.id}\n`);
}

/** `claim` — publish a single claim to the DKG. */
async function cmdClaim(args: string[]): Promise<void> {
  const statement = args.join(' ').trim();
  if (!statement) die('usage: dkg-contest claim "<statement>"');
  const transport = transportFromEnv();
  const engine = new ContestationEngine({
    transport,
    contextGraphId: `contestation-${Date.now()}`,
    reputation: new ReputationLedger(),
  });
  const claim = await engine.publishClaim({ statement });
  const v = engine.confidence(claim.id);
  process.stdout.write(JSON.stringify({ claim, verdict: v }, null, 2) + '\n');
}

const HELP = `dkg-contest — a contestation protocol for DKG Shared Memory

USAGE
  dkg-contest score [graph.json]     score a ContestationGraph (stdin or file); no node needed
  dkg-contest demo                   run a full live contestation round against your DKG node
  dkg-contest claim "<statement>"    publish one claim to the DKG

ENV
  DKG_API_URL     node HTTP API (default http://127.0.0.1:9200)
  DKG_AUTH_TOKEN  node bearer token (auto-filled by 'dkg integration install')
  DKG_HOME        alternative: discover the token from <DKG_HOME>/auth.token

Tiers: self-attested → endorsed → consensus-verified. See DESIGN.md for the confidence model.`;

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'score':
      return cmdScore(rest);
    case 'demo':
      return cmdDemo();
    case 'claim':
      return cmdClaim(rest);
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      process.stdout.write(HELP + '\n');
      return;
    default:
      die(`unknown command "${cmd}". Try: dkg-contest help`);
  }
}

main().catch((err) => die(err instanceof Error ? err.message : String(err)));

// Re-export the tier enum so `import`ers of the built CLI module can reuse it.
export { ConfidenceTier };
