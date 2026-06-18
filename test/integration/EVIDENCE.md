# Live DKG v10 Round-Trip Evidence

- **Captured:** 2026-06-18T03:05:14Z (UTC)
- **Node:** `http://127.0.0.1:9200` — DKG V10 Testnet edge node, commit `36d9daeb`, version 10.0.0-rc.17
- **Warm cg-create latency at run time:** 0.341799s
- **Result:** PASS ✅ — claim → corroborate → challenge → rebut → SWM-promotion round-trip over real HTTP

Proves the protocol writes through the node's HTTP API and promotes WM→SWM
(asset reaches memoryLayer:SWM / state:promoted), not just an in-memory model.

```

 RUN  v2.1.9 /home/hermes/origintrail/contestation-protocol

 ✓ test/integration/contestation.test.ts (1 test) 40651ms
   ✓ integration: contestation over a live DKG node > runs a full claim → challenge → corroborate → read round 38047ms

 Test Files  1 passed (1)
      Tests  1 passed (1)
   Start at  03:04:33
   Duration  41.28s (transform 202ms, setup 0ms, collect 231ms, tests 40.65s, environment 0ms, prepare 114ms)

```
