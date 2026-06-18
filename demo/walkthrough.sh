#!/usr/bin/env bash
# Narrated walkthrough for the asciinema cast. Tells the story in three beats:
#   1. The offline confidence kernel (the moat) — no node needed, deterministic.
#   2. A live contestation round against a real DKG v10 node (end-to-end proof).
#   3. The observability breakdown — WHY a claim has its score.
set -uo pipefail
cd /home/hermes/origintrail/contestation-protocol
# Use DKG_HOME token discovery exclusively; clear any inherited DKG_AUTH_TOKEN so a
# stale/multi-line value can't poison the HTTP auth header.
unset DKG_AUTH_TOKEN
export DKG_API_URL=http://127.0.0.1:9200
export DKG_HOME=/home/hermes/origintrail/.dkg-node
BIN="node dist/cli.js"

say()  { printf '\n\033[1;36m# %s\033[0m\n' "$*"; sleep 2; }
run()  { printf '\033[1;32m$ %s\033[0m\n' "$*"; sleep 1; eval "$*"; sleep 2; }

clear
say "dkg-contest — a contestation protocol for DKG Shared Memory"
say "Agents challenge & corroborate each other's knowledge."
say "Confidence EMERGES from who survives scrutiny — not from a vote."
sleep 1

say "BEAT 1 — the confidence kernel runs OFFLINE. No node. Pure function. This is the moat."
run "cat demo/weak-claim.json"
say "One bare claim, no evidence. Score it:"
run "$BIN score demo/weak-claim.json"

say "Now the SAME claim after an independent on-chain corroboration:"
run "cat demo/corroborated-claim.json"
run "$BIN score demo/corroborated-claim.json"
say "Confidence rose — earned by independent evidence, not asserted."

say "And a claim under an unrebutted challenge — confidence falls:"
run "$BIN score demo/challenged-claim.json"
say "Drop, rise, drop — all from a pure, framework-agnostic JSON-in / verdict-out kernel."

say "BEAT 2 — the full lifecycle, LIVE against a real DKG v10 node over HTTP."
say "publish -> corroborate -> challenge -> rebut -> settle, with WM->SWM promotion."
run "$BIN demo"

say "BEAT 3 — the breakdown above shows WHY: per-assertion contribution,"
say "independence discount, reputation weight. Observability, not a black box."
sleep 1
say "Claims mature along v10's trust gradient: self-attested -> endorsed -> consensus-verified."
say "That confidence signal is shaped to feed Verifiable Memory and Round-2 context oracles."
say "dkg-contest  —  github.com/iteotwawki/dkg-contestation  —  Apache-2.0"
sleep 2
