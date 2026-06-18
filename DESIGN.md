# DESIGN.md — A Contestation Protocol for DKG Shared Memory

**Status:** v2 — MVP core built and green (36 unit + 1 live-node integration test passing).
**One line:** *A framework-agnostic contestation protocol for DKG Shared Memory — agents
challenge and corroborate each other's knowledge assertions, and a confidence model turns
multi-agent scrutiny into a real trust signal.*
**Differentiator:** everyone else captures knowledge and tags its provenance. **We let agents
stress-test each other's knowledge and let confidence EMERGE from who survives scrutiny.**
**Verified substrate:** DKG v10 node rc.17 @ pin `36d9daeb`, WM→SWM→VM round-trip confirmed
over HTTP (see `integration/ROUNDTRIP.md`). This design binds only to primitives that exist today.

---

## 1. The contestation protocol

### 1.1 Primitives we build on (all verified in Gate B)
- **Claim** = a finalized WM knowledge assertion shared to SWM. It already carries a seal
  (EIP-712 AuthorAttestation, `merkleRoot`, `authorAddress`) from `/wm/finalize` — so every
  claim has a cryptographic author and content hash *for free*.
- **SWM** is the contestation arena: team-visible, gossip-replicated, free. Challenges and
  corroborations are themselves SWM assertions that *reference* the target claim.
- We do **not** invent a new transport. A contestation is RDF written via
  `POST /api/knowledge-assets` (+ `/wm/write` → `/swm/share`) or `POST /api/shared-memory/write`.

### 1.2 Assertion shapes
Ontology prefix (ours): `ct: <https://contestation.dkg/ontology#>`.

**Claim** (what gets contested) — authored by agent A:
```turtle
<claim:UAL_or_assertionUri> a ct:Claim ;
  ct:statement   "<the asserted fact>" ;
  ct:author      <agentAddress:A> ;
  ct:confidence  "self-attested" ;        # initial tier
  ct:merkleRoot  "<seal root>" .
```

**CHALLENGE** — agent B disputes claim C:
```turtle
<challenge:uuid> a ct:Challenge ;
  ct:targets       <claim:...> ;
  ct:challenger    <agentAddress:B> ;
  ct:groundsType   ct:Contradiction|ct:MissingEvidence|ct:StaleData|ct:MethodFlaw ;
  ct:evidence      <evidence:...> ;        # 0..n, see 1.3
  ct:stake         "<optional: confidence the challenger puts at risk>" ;
  ct:createdAt     "<ISO8601>" .
```

**CORROBORATE** — agent B supports claim C with independent evidence:
```turtle
<corroboration:uuid> a ct:Corroboration ;
  ct:supports      <claim:...> ;
  ct:corroborator  <agentAddress:B> ;
  ct:independence  ct:IndependentSource|ct:Replication|ct:SecondaryConfirm ;
  ct:evidence      <evidence:...> ;
  ct:createdAt     "<ISO8601>" .
```

**Evidence** (attached to either):
```turtle
<evidence:...> a ct:Evidence ;
  ct:kind   ct:OnChainFact|ct:Citation|ct:Measurement|ct:Replication|ct:Derivation ;
  ct:source "<URL / UAL / tx hash / dataset id>" ;
  ct:hash   "<content hash for tamper-evidence>" .
```

**Rules.** A challenge/corroboration MUST reference an existing claim (`ct:targets`/`ct:supports`
resolves) and MUST be authored by a *different* agent than the claim author (no self-corroboration;
self-challenge allowed = retraction). Evidence weight depends on `ct:kind` (§2.2). The claim author
may answer a challenge with a **Rebuttal** (a corroboration of their own claim that addresses the
specific `ct:groundsType`) — this is the adversarial loop.

### 1.3 The contestation lifecycle

```text
                    publishClaim
                         │
                         ▼
                 ┌───────────────┐   challenge (openChallenges>0)
        ┌───────▶│ SELF-ATTESTED │◀──────────────────────────┐
        │        │   conf = c0   │                            │
        │        └───────┬───────┘                            │
        │   ≥1 indep corroboration                            │
        │   AND 0 open challenges                              │
        │        conf ≥ endorsedAt                             │
        │                ▼                                    │
        │        ┌───────────────┐   unrebutted challenge     │
   rebut /       │   ENDORSED    │───────────────────────────▶│
   demote        │ /api/endorse  │   (veto → drops to         │
        │        └───────┬───────┘    self-attested)          │
        │  ≥k indep corroborators                              │
        │  AND 0 open challenges                               │
        │     conf ≥ consensusAt                               │
        │                ▼                                    │
        │      ┌────────────────────┐  new challenge w/ fresh │
        └──────│ CONSENSUS-VERIFIED │  evidence reopens ──────┘
               │   (VM publish =     │  (truth stays revisable)
               │    gas, gated)      │
               └────────────────────┘
```

Lifecycle in words: `claim shared → open for contestation → challenges/corroborations accrue →
confidence recomputed on each new assertion → tier transitions per §2.2 → a settled claim can be
reopened by a new challenge carrying fresh evidence (truth is revisable)`.

*Lifecycle open questions (TTL, re-opening cost, simultaneous challenges, recursive rebuttal
contestation) are collected in §7.*

### 1.4 Memory hierarchy ↔ trust gradient ↔ the spend boundary
The DKG's own memory layers map cleanly onto the trust gradient, and that mapping is what makes the
gas spend *earned* rather than arbitrary:

| memory layer | cost | trust tier | role |
|---|---|---|---|
| **WM** (Working Memory) | free, local, mutable | `self-attested` | the draft; where a claim is born |
| **SWM** (Shared Memory) | free, gossip-replicated | `self-attested → endorsed` | the **contestation arena** — challenges/corroborations live here |
| **VM / on-chain** | **gas** | `consensus-verified` | durable publish, justified only *after* surviving contestation |

Verified this session: WM write→read round-trips for free; `swm/share` promotes WM→SWM
(`state:promoted`) for free; but durable, SPARQL-queryable read-back of the literal data triples
requires on-chain context-graph registration (`finalize` returns *"not registered on-chain"*) —
i.e. **gas**. That is the natural spend boundary: a claim only crosses it once the confidence model
says it has earned `consensus-verified`. The MVP lives entirely in the free WM/SWM tiers; VM publish
is a later, operator-gated step. (No spend incurred building or testing this protocol.)

---

## 2. The confidence model (the moat — built to become subnet scoring)

The maturation ladder is v10's own trust gradient: **self-attested → endorsed →
consensus-verified**. We make *what moves a claim up or down that ladder* explicit and clean.

### 2.1 State
Each claim carries `confidence ∈ [0,1]` plus a discrete **tier**. Tier thresholds:
- `self-attested` (author only) — initial, `confidence = c0` (small, e.g. 0.30).
- `endorsed` — survived ≥1 independent corroboration and 0 unrebutted challenges; maps to the
  node's `POST /api/endorse` primitive.
- `consensus-verified` — net corroboration from ≥ *k* independent agents above a threshold with
  no open challenge; maps to `POST /api/verify` (M-of-N). Only here is VM publish justified.

### 2.2 Update rule (one clean function — this is the subnet-scoring kernel)
On each new assertion targeting claim C, recompute a scalar **pressure** and squash it around
the self-attested floor `c0`:

```text
pressure(C) = Σ_corroborations  w_kind · indep(agent) · rep(agent)
            − Σ_open_challenges  w_grounds · evidenceWeight · indep(agent) · rep(agent) · (1 − rebutted)

# c0-anchored squash: zero pressure → exactly c0; net support → toward 1; net challenge → toward 0
half       = logistic(k · pressure) − 0.5            # ∈ (−0.5, 0.5)
confidence = half ≥ 0 ? c0 + 2·half·(1 − c0)         # support stretches c0→1
                      : c0 + 2·half·c0               # challenge compresses c0→0
```

Anchoring on `c0` (rather than the naive `clamp01(logistic(score))`) guarantees an *uncontested*
claim reads exactly the self-attested floor — the behaviour §2.1 specifies. The reference
implementation (`src/confidence.ts`) is a **pure, total function**; every term below is a tunable
parameter, not a magic number.

**Terms.**
- `w_kind` / `w_grounds` — evidence-type and challenge-grounds weights (below). We take the
  **max** evidence weight on an assertion, not the sum, so flooding an assertion with many weak
  citations cannot out-vote one strong on-chain fact (closes the evidence-flooding vector).
- `indep(agent)` ∈ [0,1] — **diversity discount** (§2.2a). The anti-gaming core.
- `rep(agent)` ∈ [0,1] — the agent's track record; EWMA over settled outcomes. **This is literally
  the miner score.** Cold-start = `defaultRep` (the self-attested floor 0.3, *not* neutral 0.5 — see §2.2b).
- `rebutted ∈ [0,1]` — the **evidence-bounded** rebuttal level over author-rebuttals targeting that
  challenge (see §2.2c). A fully-rebutted challenge (1.0) contributes zero downward pressure **and**
  stops counting as open; a partially-rebutted one stays open and only partly attenuated.

**Parameters & defaults** (frozen in `DEFAULT_PARAMS`; a subnet would govern these on-chain):

| param | default | meaning |
|---|---|---|
| `c0` | 0.30 | self-attested floor; confidence of an uncontested claim |
| `k` | 1.0 | logistic steepness (maturation speed) |
| `endorsedAt` | 0.55 | confidence threshold for the endorsed tier (3 strong cold-start corroborators ≈0.595 clear it) |
| `consensusAt` | 0.74 | threshold for consensus-verified — at the 0.3 cold-start, reachable only by agents who have EARNED reputation, not three strangers |
| `consensusMinAgents` | 3 | min distinct independent corroborators for consensus |
| `defaultRep` | 0.30 | cold-start reputation for an unseen agent (the self-attested floor) |
| `w_kind` | OnChainFact 1.0, Replication 0.8, Measurement 0.6, Citation 0.4, Derivation 0.25 | evidence-kind weights |
| `w_grounds` | Contradiction 1.0, MethodFlaw 0.8, StaleData 0.6, MissingEvidence 0.5 | challenge-grounds weights |
| `coOccurrenceWindowMs` | 300000 | sybil co-occurrence window (5 min, §2.2a) |
| `coOccurrenceAmplifier` | 1.5 | overlap amplification for co-occurring assertions |
| `correlationPenalty` | 1.0 | how hard the worst correlated twin pulls `indep` down |

**The asymmetry is deliberate and challenge-privileged.** Tier promotion is hard-gated on
`openChallenges === 0`: no volume of corroboration can promote a claim past `self-attested` while
a single unrebutted challenge stands. Corroborations move only the continuous scalar; a credible
challenge holds an absolute veto on *maturation*. Surviving a strong challenge is more
epistemically informative than accumulating easy agreement (falsification > confirmation).

### 2.2a `indep(agent)` — the diversity discount (graded, not binary)
The known attack is collusive mutual-corroboration: a swarm of sybil agents citing the same
evidence to inflate confidence. `indep()` suppresses it with two graded signals, computed against
every prior accepted assertion **within the same cohort**:

1. **Jaccard source overlap** — `|sources ∩ prior| / |sources ∪ prior|`. Sharing an actor's exact
   source set → overlap 1.0 → fully discounted; partial overlap → partial discount.
2. **Temporal co-occurrence** — overlap that *also* lands within `coOccurrenceWindowMs` of the
   assertion it overlaps is amplified by `coOccurrenceAmplifier`. A swarm citing identical sources
   within minutes is far more suspicious than two agents independently reaching the same source
   days apart. `indep = clamp01(1 − correlationPenalty · worstCorrelation)`.

Corroborators and challengers get **separate** diversity trackers. A challenger reinterpreting the
same on-chain fact a corroborator cited is legitimate adversarial reuse — arguing the opposite from
shared evidence — *not* sybil correlation, so it is never cross-penalized. The claim author's own
corroborations always score 0 (no self-corroboration). This is the MVP's honest sybil-resistance;
hardening it (stake-weighting, graph-clustering, evidence provenance depth) is the subnet's core
research problem (§5).

### 2.2b Reputation bootstrapping — why cold-start is the self-attested floor (0.3), not neutral
New agents start at `defaultRep = 0.3` — the same self-attested floor a fresh *claim* starts at —
**not** neutral 0.5. The symmetry is the point: a new agent is itself "self-attested", unproven
until its contestations survive settled outcomes, then it earns influence up via the reputation
EWMA. Influence is earned by surviving scrutiny — identical to the thesis for claims. Starting at 0
would hand incumbents a structural moat and punish honest newcomers; starting at 0.5 gives a fresh
sybil real day-one influence while `indep()` is still being tuned. 0.3 is the low-regret middle:
0.5-too-high risks false confidence (the credibility killer), 0.3-too-low is mild, recoverable
newcomer friction. Sybil-resistance lives in `indep()`, not rep-suppression; a sybil *swarm* sharing
sources is crushed by the diversity discount regardless of rep. Kept configurable (`defaultRep`) so
the TAO-loop experiment can sweep it. (Operator-confirmed, 2026-06-17.)

### 2.2c Rebuttal shape — and why `rebuttalStrength` is evidence-bounded
A **Rebuttal** is a corroboration authored by the claim author that targets a specific challenge,
carrying two extra fields:
- `rebuts` — the challenge id it answers.
- `rebuttalStrength ∈ [0,1]` — the author's DECLARED claim of how completely it addresses the
  challenge's grounds.

The declared strength is **not trusted on its own** — otherwise an author could neutralize any
challenge by asserting `rebuttalStrength: 1` with a token reply, breaking the challenge-privileged
asymmetry that is the heart of the model. So it is capped by the rebuttal's evidence strength
relative to the challenge's grounds weight:

```text
evidenceCap       = min(1, bestRebuttalEvidenceWeight / challengeGroundsWeight)
effectiveStrength = min(declaredStrength, evidenceCap)
```

Consequences:
- A rebuttal with **no evidence** → cap 0 → cannot rebut at all (a bare "I answered" is worthless).
- You **cannot** fully dismiss a `Contradiction` (grounds 1.0) with a `Citation` (evidence 0.4):
  cap 0.4, so the challenge stays 60% in force and **remains open**.
- An `OnChainFact` (1.0) fully answers even a Contradiction.

A challenge stops counting as `open` only when some rebuttal reaches `effectiveStrength = 1`.
*(Rebuttals are not yet themselves contestable — recursive challenge-of-a-rebuttal is a v0.2.0
lifecycle item; see Open Questions.)*

### 2.3 Why this is subnet-ready (roadmap step 3)
A Bittensor subnet needs a scalar per participant that rewards truth-seeking and resists gaming.
`rep(agent)` *is* that scalar: "score agents on whether their claims and contestations survive
scrutiny." The diversity discount `indep()` is the sybil-resistance a subnet validator needs.
Building it now — even though the bounty only needs a single claim to mature — is what makes the
endgame possible. **Design constraint honored: the confidence kernel is a pure function of
(evidence, agent-diversity, agent-reputation) with no Hermes-specific coupling.**

---

## 3. MVP scope (smallest demonstrably-working core; resist sprawl)

**In:**
1. `ct:` ontology + claim/challenge/corroborate/evidence assertion writers over the verified HTTP
   API (create→write→finalize→share).
2. Confidence engine implementing §2.2 with: the full evidence-kind ladder (OnChainFact,
   Replication, Measurement, Citation, Derivation), **graded `indep()`** (Jaccard source overlap +
   temporal co-occurrence, §2.2a — upgraded from the originally-scoped binary check), and `rep` =
   survival EWMA.
3. Tier transitions wired to `/api/endorse` (→endorsed) and a local `/api/verify` proposal
   (→consensus-verified). **No VM publish in the MVP** (stays free; VM is a later gated step).
4. A read API: "give me claim C with its current confidence, tier, and the contestation graph."
5. The agent-facing skill (SKILL.md) so any adapter client can play.

**Out (deferred):** full sybil/diversity modelling, weighted M-of-N economics, VM/on-chain
settlement, multi-CG federation, the subnet itself. Ship a working core, not a spec.

**Framework-agnostic:** the client contract is `(claim|challenge|corroborate|read)` over plain
HTTP + the `ct:` ontology. Hermes and OpenClaw are just two clients; nothing in the core imports
either runtime.

---

## 4. The TAO-loop demo (roadmap step 2 — the quality-signal proof)

**Credible first user:** the Janus↔reborn TAO-mining research loop. Today they swap research via
VPS files/AGENTS.md with no adversarial check. We replace that with contested Shared Memory:

- reborn (miner) publishes a **Claim**: e.g. *"SN15 ORO emissions favor low-latency inference
  miners; topology T3."*
- Janus (advisor) **CHALLENGES** with `ct:groundsType ct:StaleData` + evidence (a newer taostats
  measurement), or **CORROBORATES** with an independent on-chain emission reading.
- The confidence engine matures (or demotes) the claim. **The proof:** does a claim's settled
  confidence correlate with whether it actually held up in subsequent mining results? If
  high-confidence claims predict reality better than raw self-attested ones, contestation produced
  a **real** quality signal — not just ceremony. That is the step-2 success criterion, measurable
  on data we already generate.

**Concrete success metric.** Rank every settled claim by confidence; take the top-K. Target:
**precision@K of `consensus-verified`/`endorsed` claims ≥ 20% higher than the self-attested
baseline** on subsequent mining outcomes (i.e. claims the protocol rated high should hold up in
reality measurably more often than uncontested ones). A null or negative lift falsifies the
hypothesis that contestation adds signal — which we'd report honestly, because a measurable null is
itself the step-2 finding. Secondary metrics: Brier score of `confidence` as a probability, and
challenge-survival rate vs. eventual correctness.

---

## 5. Forward path: could-be-a-subnet + the Round-2 oracle hook

- **Subnet (step 3):** expose `rep(agent)` as the validator's scoring vector; challenges/
  corroborations become the miner task; the diversity discount becomes sybil resistance. The
  confidence kernel (§2.2) drops in as the reward function. Eyes open on gaming: the known attack
  is collusive mutual-corroboration → that's exactly what `indep()` is designed to suppress, and
  hardening it is the subnet's core research problem.
- **The governing principle for any incentive layer: reward verifiable work, never consensus
  agreement.** Rewarding "you agreed with the majority" builds a *conformity engine* — a token-fed
  echo chamber that manufactures consensus-flavored falsehood. Rewarding "you falsified a claim that
  reality later disproved" or "you checked evidence against a primary source and it held" builds a
  *truth engine*. The incentive must point at verifiable contribution, not crowd-matching. This is
  also what keeps validators converging (the Yuma-consensus problem): objective, evidence-anchored
  resolution is the common thread. A subnet here is plausibly the answer to "why would anyone spend
  resources contesting for free" (it pays for the production of a public good) — but note stake
  *secures and disciplines* an external truth anchor, it does not *create* one; reality (or the §2.2a
  evidence checker) still has to be the thing stakers bet toward, or you get a Keynesian beauty
  contest on subjective truth.
- **Round-2 Context-Oracle / ClaimReview hook:** the field's strongest PRs (#3, #16) tee up
  "Context Oracle / ClaimReview consumption." Our settled `(claim, confidence, tier, evidence
  graph)` **is** a ClaimReview-shaped record — we emit it in schema.org `ClaimReview` form so we're
  the verification layer they're all gesturing toward but none are building. We consume provenance
  (The Triad #15's lane) as *input evidence* and produce a contestation-scored verdict as *output*:
  complementary, not competing.

---

## 6. Limitations & threat model (what this does NOT yet do)

Stated plainly, because knowing a system's edges is a credibility *gain*, not a confession:

- **Evidence is self-asserted (the big one).** The confidence model produces trust from agents
  *agreeing and disagreeing*; it does **not** verify the evidence is real. An agent citing
  `OnChainFact` evidence `tx:0x…` is weighted highly, but nothing yet confirms the transaction
  actually says what the agent claims. The diversity discount stops a sybil *swarm*; it does **not**
  stop one sophisticated liar citing plausible-but-fabricated evidence.
- **What the DKG verifies vs. what it doesn't.** The DKG guarantees *integrity* (sealed,
  tamper-evident), *provenance* (who/when), and *availability* — for free, and we lean on it. It does
  **not** verify *truth*: it is designed to hold "A says X" and "B says not-X" simultaneously.
  Truth-via-DKG would be circular (accepted → published → cited as evidence → accepted), an echo
  chamber. Truth must be anchored to something *external* to the assertion graph — a primary-source
  check or stake. That anchor is the **v0.2.0 evidence checker** (§2.2a "oracle-lite": actually read
  the chain state, don't trust the assertion *about* it) and, later, the subnet.
- **Coherentist now, foundationalist later.** Contestation is an *internal* mechanism (agents
  checking each other) and can converge on a coherent set of falsehoods. The evidence checker is the
  foundationalist anchor that grounds it. This is a *correctly layered* design — integrity (DKG,
  free) + coherentist scrutiny (this protocol) + foundationalist anchor (v0.2.0 oracle) — not a hole.
- **Cheap honest sliver available now:** evidence *integrity* (content-hash match) + *availability*
  (source resolves), which filters fabricated sources without pretending to do semantic verification.
  Deferred to v0.2.0 alongside the DKG-native-evidence provenance multiplier (sealed KA/UAL → higher
  weight; raw agent-typed string → lower) — source trust-scoring done non-circularly.
- **In-process graph index (not yet durable across restart).** The engine keeps the per-claim
  assertion graph in-process; `requireGraph` throws on an unknown claim id, so a node restart loses the
  index even though the underlying claims/challenges/corroborations remain durable in SWM. This is fine
  for the MVP/demo (single long-lived process) but a multi-process or restart-tolerant deployment needs
  a **`rebuildFromSWM()` warm-start** that repopulates the index by reading the context graph's SWM
  state on boot. This is the **top v0.2.0 item** — the data is already durable; only the cache is volatile.
- **`/api/endorse` is speculative (unverified route).** Every other transport endpoint was diffed
  against the first-party DKG adapters and matches exactly; `/api/endorse` does **not** appear in either
  official adapter, so the real endorse path may differ or not exist as a public route. It is gated
  behind `enableEndorse: false` (default), treats a 404 as non-fatal, and is **never called by the
  installed CLI** — so it cannot break the lifecycle. Treat it as a forward hook to confirm against a
  live node before relying on it, not a proven integration point.

---

## 7. Open questions (lifecycle — called out, not yet solved)

- **TTL window.** Fixed duration vs. dynamic (importance-weighted)? MVP: no hard close — confidence
  is always live; "settle" is a snapshot, not a freeze.
- **Re-opening settled claims.** A `consensus-verified` claim is never frozen (truth is revisable),
  but to prevent churn, re-opening should cost the challenger a stake. The optional `ct:stake` field
  exists for this; enforcement is deferred.
- **Simultaneous / conflicting challenges.** The kernel is order-independent (pure over the assertion
  set), so concurrent challenges compose deterministically; conflicting challenges both count until
  rebutted. Resolving *which* is correct is the contestation, not a tie-break we impose.
- **Recursive contestation of rebuttals.** A rebuttal is currently evidence-bounded (§2.2c) but not
  itself challengeable. Making rebuttals first-class contestable assertions is a v0.2.0 item.

---

## Resolved decisions
- **Repo home:** `github.com/iteotwawki/dkg-contestation` (Apache-2.0, npm `@iteotwawki/dkg-contestation`).
- **Scope:** FLAGSHIP (8–10k TRAC) — §2's diversity/reputation depth earns the tier.
- **`ct:` ontology IRI:** `https://contestation.dkg/ontology#` (operator-confirmed; open to an
  OriginTrail-aligned namespace if the committee prefers).
