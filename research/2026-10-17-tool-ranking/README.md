# Tool-ranking comparison, 17 October 2026

This package contains 1,584 recorded pairs from two repetitions of 792 Raven case occurrences. It compares Original search with the optional Jev ranking adapter on commit `b1dc8663b37a4795f50538918fdf5f4b08c6b054`. Both variants use the same questions, catalog variants, and visible limits.

Jev improves several ranking measures and loses others. Its Raven quality gate fails in both repetitions. An offline evidence check that prints `PASS` means the stored data and calculations agree. It does not mean Jev passes the quality gate.

Run from the repository root with Node 24.11.1:

```sh
node research/2026-10-17-tool-ranking/recompute.mjs --check
node --test research/2026-10-17-tool-ranking/recompute-checks.mjs
```

The [development-overlap disclosure](METHOD.md#development-overlap) identifies 14 holdout questions used during development. Recalculate the other 35 questions and check the subset command with:

```sh
node research/2026-10-17-tool-ranking/recompute-holdout-subset.mjs
node --test research/2026-10-17-tool-ranking/holdout-subset-checks.mjs
```

The checker uses only local files and Node's standard library. It requires no dependencies, credentials, or network access. It writes no result files and starts no inference.
`recompute-checks.mjs` creates and removes a short-lived directory inside this package folder, so it needs write access there. The subset checks write no files.

| Measure | Original, both repetitions | Jev 1 | Jev 2 |
| --- | ---: | ---: | ---: |
| Legacy service top-1 / 3 / 5, 338 cases | 219 / 298 / 326 | 242 / 309 / 325 | 244 / 310 / 328 |
| Legacy card@5, 182 applicable cases | 112 | 134 | 137 |
| Extended service top-1 / 3 / 5, 122 cases | 93 / 111 / 117 | 82 / 107 / 115 | 80 / 107 / 114 |
| Extended card@5, 28 applicable cases | 16 | 11 | 11 |
| Skills service top-1, 23 cases | 17 | 22 | 22 |
| Holdout exact-card top-1 / 3 / 5, 49 cases | 12 / 26 / 29 | 36 / 46 / 47 | 36 / 46 / 47 |
| Holdout cases with a forbidden hit | 10 | 21 | 20 |
| Holdout PASS | 24 | 27 | 28 |
| Protocol history v1, research tool top-1 / top-5, 8 required cases | 7 / 7 | 4 / 8 | 5 / 8 |
| Protocol history v1, research tool in 4 control cases (lower is better) | 3 | 1 | 1 |
| Discovery family@3 / operation@5, 43 cases | 35 / 29 | 43 / 43 | 43 / 43 |
| Replay family@3 / operation@5, 91 occurrences | 44 / 42 | 60 / 76 | 61 / 74 |
| Drift predicates satisfied, 78 calls | 75 | 68 | 71 |

The legacy gate uses a symmetric band. Jev's top-1 and top-3 gains exceed its upper boundary. The additional forbidden holdout hits are separate losses under Raven's labels. Extended losses remain visible although that group is outside the numeric gate. The protocol-history v1 contract fails for both variants in both repetitions.

Original returns the same ordered lists in both repetitions. Jev's ordered list differs between its two repetitions for 377 of 792 case occurrences. Twenty-seven of those cases change at least one graded boolean criterion between repetitions. The result measures tool selection, not answer quality or deployed-server latency.

[METHOD.md](METHOD.md) defines the populations, grading, timing, and execution procedure. [MARKED-CASES.md](MARKED-CASES.md) lists all 21 cases marked before this comparison was run, with card ranks and official grading gains and losses. `--inspect` exposes all diagnostic deltas. These marks preserve upstream concerns and guards; they do not classify every marked case as an unresolved bug.

Inspect a question, both rankings, and all candidate scores without unpacking the whole archive:

```sh
node research/2026-10-17-tool-ranking/recompute.mjs --inspect holdout:q-holdout-a-05-groth16-soroban
node research/2026-10-17-tool-ranking/recompute.mjs --request holdout:q-holdout-a-05-groth16-soroban
```

`--request` prints the recorded API input representation. It does not send the request. A provider bypass prints `null`.

For a readable JSON export:

```sh
node research/2026-10-17-tool-ranking/recompute.mjs --dump data > ranking-data.json
node research/2026-10-17-tool-ranking/recompute.mjs --dump expected > ranking-expected.json
```

`data.json.gz` stores catalog entries, effective labels, Original pages, and candidate pools once. Observations reference those inputs and retain scores, returned pages, raw response bodies, decisions, usage, and timing. `expected.json.gz` contains metrics exported from the separately checked final analysis. The checker compares every case delta as well as the aggregate results. `manifest.json` binds the files and their source fingerprints.

All 13 error fallbacks remain in the comparison: twelve HTTP 529 responses and one conflicting choice response. Ten observations bypass the provider. Known usage implies $0.589828344 at the recorded tariff. Twelve charges remain unknown, with $0.033030144 reserved for them. The full $4.332453888 reservation already includes that amount. These figures do not establish the invoice total.
