# US KYC policy

The reviewed policy this platform enforces, as content a policy owner can read and argue
with. Nothing here is code: the machinery that loads, evaluates and compiles it lives in
`packages/policy-engine` and knows nothing about KYC.

| Path | What it holds |
| --- | --- |
| `policy.yaml` | Authority, compilation target, institution settings, authority matrix, gate bindings, routing and audit requirements |
| `catalog/rules.yaml` | The rule inventory, with regulatory basis and who may act on each rule |
| `catalog/reason-codes.yaml` | The outcome vocabulary, and the routing queue and analyst guidance per code |
| `catalog/evidence-obligations.yaml` | What a piece of evidence must be to discharge an obligation |
| `catalog/cohorts.yaml` | Risk and failure cohorts, cohort assignment, corpus coverage floors |
| `catalog/owner-inputs.yaml` | What the institution has not yet decided, and whether it blocks release |
| `catalog/decision-tables/` | The three gates, as first-hit tables over discrete condition tokens |
| `fixtures/corpus/` | The adjudicated golden corpus and its manifest |
| `fixtures/providers/` | Provider-neutral screening results and failure modes |
| `fixtures/uat/` | Scenarios an operations reviewer runs before launch |

## Working on it

```sh
pnpm --filter @ehf/kyc-policy test                 # catalog integrity, corpus, OPA conformance
pnpm --filter @ehf/kyc-policy corpus:generate      # regenerate the corpus (deterministic)
pnpm --filter @ehf/policy-engine compile:kyc       # re-emit artifacts/policy/kyc
```

This bundle is a **candidate**. `catalog/owner-inputs.yaml` lists the institution decisions
still outstanding; compiling for production fails while any of them blocks release, and the
disposition gate reaches no outcome at all against a case whose
`policyConfiguration.productionReady` is not true. A candidate bundle can be compiled,
evaluated and shadowed. It is never runtime authority over a customer.
