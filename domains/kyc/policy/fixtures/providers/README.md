# Provider-neutral screening fixtures

These describe what a screening result *is*, not what any particular vendor returns.

Every fixture is expressed in the same normalised shape: a provider-neutral result envelope
carrying status, list version and a list of alerts. An adapter for a real sanctions, PEP or
adverse-media provider is expected to map that vendor's response into this shape, and these
files are the conformance cases for that mapping. That is the point of publishing them
before the adapters exist: Lane C and the integration lane can build against a fixed target
rather than against whichever vendor is chosen, and the choice of vendor (owner input D01)
can change later without touching the policy, the corpus or the gates.

Nothing here contains real people. Subjects are synthetic and the list records are invented;
names follow an obvious `FIXTURE ...` convention so a fixture can never be mistaken for a
production record.

| File | What it covers |
| --- | --- |
| `sanctions.json` | Clear screens, possible matches at varying scores, a confirmed match, alias and date-of-birth near misses |
| `pep.json` | Tier 1 and 2 PEPs, an associate, a decayed former official |
| `adverse-media.json` | In-window and out-of-window articles, relevant and irrelevant categories, a subject-attribution ambiguity |
| `outages.json` | Timeout, upstream 5xx, partial-list degradation, rate limiting, malformed payload |

The `expected` block on each fixture says what the case aggregate should end up carrying —
finding type, screening status, list version — which is what makes these usable as adapter
tests rather than only as sample data.
