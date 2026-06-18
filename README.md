# dkg-contestation

**A framework-agnostic contestation protocol for the OriginTrail DKG (v10 Shared Memory).**

Everyone else captures knowledge and tags its provenance. This lets agents **stress-test each
other's knowledge** — and lets confidence *emerge* from who survives scrutiny.

Agents publish knowledge **claims** to DKG Shared Memory. Other agents **challenge** or
**corroborate** them with evidence. A pure **confidence model** turns that multi-agent scrutiny
into a real trust signal that matures along v10's trust gradient:

```
self-attested  ──►  endorsed  ──►  consensus-verified
   (c0=0.30)      (≥1 indep,     (≥k indep corroborators,
                   0 challenges)   high confidence, 0 challenges)
```

A claim cannot mature while a single unrebutted challenge stands. Confidence is **earned by
surviving challenge**, not by accumulating easy agreement.

---

## Why this exists

Multi-agent systems increasingly share memory — but shared memory with no adversarial check is
just a louder echo chamber. A wrong claim, corroborated by ten copies of the same agent, looks
authoritative. This protocol makes knowledge *contestable*: every assertion carries a confidence
score that reflects how much independent scrutiny it has survived, with built-in sybil resistance
so a swarm citing the same source can't manufacture consensus.

The confidence kernel is a **pure function of (evidence, agent-diversity, agent-reputation)** with
no framework coupling — which is exactly what a Bittensor-style subnet would need as a validator
scoring mechanism. See [`DESIGN.md`](./DESIGN.md) for the full specification and forward path.

---

## Install

```bash
# via the DKG integrations registry (recommended)
dkg integration install dkg-contestation

# or directly from npm
npm install -g @iteotwawki/dkg-contestation   # CLI: dkg-contest
npm install @iteotwawki/dkg-contestation      # library
```

The CLI auto-discovers your node token when `dkg integration install` wires it; otherwise set
`DKG_API_URL` (default `http://127.0.0.1:9200`) and `DKG_AUTH_TOKEN` (or `DKG_HOME`).

---

## Quickstart

### CLI

```bash
# Score a contestation graph OFFLINE — no node required (this is the confidence kernel)
echo '{"claim":{"id":"c:1","statement":"...","author":"0xA","createdAt":"2026-06-17T00:00:00Z"},
       "challenges":[],
       "corroborations":[{"id":"k1","supports":"c:1","corroborator":"0xB",
         "independence":"IndependentSource",
         "evidence":[{"id":"e1","kind":"OnChainFact","source":"tx:1","hash":"h"}],
         "createdAt":"2026-06-17T01:00:00Z"}]}' | dkg-contest score

# Run a full contestation round against your live DKG node
dkg-contest demo

# Publish a single claim
dkg-contest claim "SN15 emissions favor low-latency inference miners"
```

### Library

```ts
import {
  ContestationEngine,
  HttpDkgTransport,
  ReputationLedger,
  EvidenceKind,
  Independence,
  ChallengeGrounds,
} from '@iteotwawki/dkg-contestation';

const transport = new HttpDkgTransport({ dkgHome: process.env.DKG_HOME });
const engine = new ContestationEngine({
  transport,
  contextGraphId: `contestation-${Date.now()}`,
  reputation: new ReputationLedger(),
});

// 1. an agent publishes a claim
const claim = await engine.publishClaim({
  statement: 'Contestation produces a real quality signal.',
});
engine.confidence(claim.id);        // → tier: self-attested, confidence: 0.30

// 2. another agent corroborates with independent on-chain evidence
await engine.corroborate({
  claimId: claim.id,
  corroborator: '0xCorroboratorA',
  independence: Independence.IndependentSource,
  evidence: [{ id: 'ev:a', kind: EvidenceKind.OnChainFact, source: 'tx:0xfeed', hash: 'h:a' }],
});

// 3. a skeptic challenges it
const challenge = await engine.challenge({
  claimId: claim.id,
  challenger: '0xSkeptic',
  groundsType: ChallengeGrounds.MissingEvidence,
  evidence: [{ id: 'ev:c', kind: EvidenceKind.Citation, source: 'doc:doubt', hash: 'h:c' }],
});
engine.confidence(claim.id);        // → still self-attested: an open challenge vetoes maturation

// 4. the author rebuts; the claim can mature again
await engine.corroborate({
  claimId: claim.id, corroborator: claim.author,
  independence: Independence.SecondaryConfirm,
  rebuts: challenge.id, rebuttalStrength: 1,
  evidence: [{ id: 'ev:r', kind: EvidenceKind.Measurement, source: 'measure:1', hash: 'h:r' }],
});

const verdict = await engine.settle(claim.id);   // folds outcomes into reputation
```

The pure kernel is also usable standalone, no node, no I/O:

```ts
import { computeConfidence } from '@iteotwawki/dkg-contestation';
const verdict = computeConfidence(contestationGraph);   // { confidence, tier, ... }
```

---

## The confidence model in one paragraph

Each new assertion recomputes a scalar **pressure**: corroborations push it up, open challenges
pull it down, each weighted by evidence kind (`OnChainFact > Replication > Measurement > Citation >
Derivation`), a **diversity discount** `indep()`, and the agent's **reputation**. Pressure is
squashed around the self-attested floor `c0` into `confidence ∈ [0,1]`. `indep()` is the
anti-gaming core: it discounts corroborators whose evidence sources overlap (graded Jaccard
similarity) — amplified when they also publish within a short time window (a swarm signal). Tier
promotion is hard-gated on zero open challenges, so falsification always beats confirmation. Full
math, parameters, and the subnet-scoring forward path are in [`DESIGN.md`](./DESIGN.md); the
agent-facing contract is in [`SKILL.md`](./SKILL.md).

---

## Architecture

```
ContestationEngine          orchestrates claim/challenge/corroborate/settle
   ├── computeConfidence()  PURE confidence kernel  (confidence.ts)  ← the moat
   ├── ReputationLedger     EWMA over settled outcomes (reputation.ts)
   └── DkgTransport         the framework-agnostic seam (transport.ts)
        └── HttpDkgTransport  reference impl over the DKG v10 rc.17 HTTP API
```

Any client — Hermes, OpenClaw, an MCP server, a raw HTTP script — participates by implementing the
`DkgTransport` interface or by speaking the `ct:` ontology over the node's HTTP API. Nothing in the
core imports any agent runtime.

---

## Memory layers & cost

| layer | cost | trust tier | role |
|---|---|---|---|
| **WM** Working Memory | free, local | self-attested | the draft |
| **SWM** Shared Memory | free, replicated | self-attested → endorsed | the contestation arena |
| **VM** Verifiable Memory | **gas** | consensus-verified | durable publish, earned by surviving contestation |

This protocol operates entirely in the free WM/SWM tiers. On-chain VM publish is a later,
operator-gated step — a claim only crosses the spend boundary once it has *earned*
`consensus-verified`.

---

## Develop

```bash
npm install
npm run typecheck
npm run build
npm run test:unit          # 22 pure-kernel tests, no node needed
npm run test:integration   # full round against a live DKG node (set DKG_API_URL + DKG_HOME)
npm test                   # everything
```

---

## License

[Apache-2.0](./LICENSE).
