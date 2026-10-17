# Method and reproduction

The frozen input is Raven commit `b1dc8663b37a4795f50538918fdf5f4b08c6b054`. The accepted catalog fingerprint is `4852f62608f105cfff34fdc7e01cdfe886bbeaca69250b8ea5f76d03d5208064`. The data archive stores questions, effective labels, and source fingerprints. Effective accept-either labels preserve the union of the compiled labels and the build-question overlay.

## Population

| Group | Occurrences per repetition | Visible limit | Interpretation |
| --- | ---: | --- | --- |
| Legacy | 338 | 5 | Strict service and tolerant card matching |
| Extended | 122 | 5 | Same measures, separate denominator |
| Skills | 23 | 5 | Skill service and card matching |
| Holdout | 49 | 5 | Exact card matching and forbidden-hit exclusion |
| Protocol history v1 | 12 | 5 | Eight required targets and four exclusion controls |
| Discovery | 43 | 8 | Expected family@3 and usable operation@5 |
| Replay | 91 | 8 | Recorded occurrences, including repeated questions |
| Drift | 78 | Per fixture | Original include, exclude, first-hit, tier, and page predicates |
| Protocol history v2 | 32 | 5 | Ungraded rank observations; source epoch expired |
| Additional account-merge check | 1 | 5 | Raven acceptance predicate |
| Technical acceptance variants | 3 | 5 | Two graded protection fixtures and one ungraded whole-word diagnostic |
| Total | 792 | | Two repetitions produce 1,584 pairs |

The technical variants use Raven's acceptance helper. They are identified separately from quality questions. The package excludes separate development and control-question collections. The RWA fixture catalog stays separate from the accepted catalog. Three Original drift cases retain their failing predicate even though the upstream test marks them with `it.fails`.

The 32 v2 observations do not renew their expired source contract. A fresh source variant described in upstream notes was not committed with the frozen input. This package makes no quality claim about that unavailable snapshot.

## Development overlap

Fourteen of the 49 Raven holdout questions appear in the contributor's 20-question development set. The [subset command](recompute-holdout-subset.mjs) lists their exact IDs and reports the other 35 questions separately.
The ID list is a disclosure from the contributor's development records. The package verifies the numerical results, not the development history.
This is a retrospective split of the recorded comparison, not a new blind evaluation. The full 49-case results and all original observations remain part of the package.

```sh
node research/2026-10-17-tool-ranking/recompute-holdout-subset.mjs
```

The command verifies package integrity and recomputes all archived grades before summarizing the remaining cases. Its JSON output includes the 14 disclosed IDs and four rows, one per variant and repetition. It requires Node 24 and uses local files only; it writes no files and makes no provider requests.

| Measure on the other 35 questions | Original | Jev | Jev repeat |
| --- | ---: | ---: | ---: |
| Expected tool first | 9/35 | 24/35 | 24/35 |
| Expected tool in first five | 20/35 | 33/35 | 33/35 |
| Case passes | 17/35 | 17/35 | 18/35 |
| Cases showing an excluded tool (lower is better) | 8/35 | 17/35 | 16/35 |

## Ranking and grading

The recording uses Original pages and pools of at most 50 candidates from the same search implementation. A parity check confirms matching pages and pools between the two local code copies. The public package recomputes rankings and grades from those frozen pages; it does not execute the Original search again.

Each eligible provider input contains the question and candidate ID, service, kind, and complete short description. The request serializes candidates in ascending ID order. The request excludes schemas, signatures, and Original scores. The exact instruction is stored once under `api.instruction`. The model is `jev-1.14.0` and the endpoint is `https://api.typesafe.ai/v1/systemone`.

Returned probabilities reorder the same candidate pool in descending order. Ties retain Original pool order. The visible limit stays unchanged. A failure returns the entire original page. Exact-ID requests and insufficient candidate sets bypass the provider. The archive retains both visible-page metadata and the candidate pool.

The `lib` files preserve the measured grading functions. Raven's card and service grader is copied unchanged. The export extracts its discovery grading functions unchanged. The routing wrapper preserves holdout, protocol, and gate checks. Its file reads use the archived inputs and fingerprints. The export extracts additional predicates and aggregate calculations from the measured offline evaluation. Source hashes identify each input to this export.

Raven's gate keeps its symmetric legacy band, skill floor, separate holdout rank floors and forbidden-capture ceiling. Positive band exceedances remain separate from regressions. Diagnostic card ranks do not replace gate metrics. The expected metrics come from the separately checked original final analysis run. The package re-executes the same grading code on the archived inputs and must reproduce them exactly. This checks reproduction, not agreement between independent implementations.

## Execution and failures

Repetition 2 reverses case order. Original and Jev alternate execution order within each repetition. Each observation has one visible page from each variant. Both repetitions contribute without best-of selection.

The execution has three preserved segments: 1 through 79, 80 through 673, and 674 through 1,584. Segment 1 stops after three consecutive HTTP 529 responses. Segment 2 stops at a contradictory choice response. The continuation at 674 adds explicit choice-conflict classification and stops after three consecutive conflicts. Each conflict still returns the original page. The probability-based ranking rule and failed observation at 673 remain unchanged. The raw responses and decision fields expose that boundary.

No observation repeats to replace an error. Segments 2 and 3 allow bounded pauses after transient failures, with a shared maximum of 570 seconds. Neither continuation uses a pause in this run. Every physical start reserves 65,536 input tokens at 42 nano-USD per token. Output tokens are free under the recorded tariff. The measurement made 1,574 physical starts, matching its maximum attempt budget. Requests start one at a time, at least 1,000 ms apart. The local resolver and provider timeout are 2,000 ms.

The active-runtime ceiling is 3,600,000 ms across segments. Observed active runtime is 2,210,624.889 ms, excluding interruptions between segments. Raw recording has a 256 MiB limit. A closed segment preserves unknown usage and its reservation. The package adds the original segment counters once and checks them against every response and observation.

Resolver timings include different binding-check overhead across segments. Transport timing starts later. These sections have different case mixtures, so pooled timings do not establish a controlled product-latency improvement. The measurement excludes answer models, MCP transport, browsers, and deployed-host timing.

## Running a new measurement

The included commands perform offline checks only. A new live measurement requires a separate output directory and its own authorization, provider credentials, and spending limit. Check the current model contract, price, and availability before sending requests; this archive records the contract used on 17 October 2026.

Use `--request CASE_KEY` to render the exact JSON input, or implement the same rendering from the archived case and pool. Send one HTTP POST with JSON content to the recorded endpoint using credentials held outside the artifact directory. Keep request and response size limits at 65,536 bytes. Do not put authorization headers or account details in result files.

Preserve both repetitions, their order, and all labels. Record the request hash before dispatch, raw response bytes, status, usage, monotonic timing, original page, returned page, and decision. Validate model identity and a finite score for every candidate. Preserve original order for tied scores. Keep every error as a fallback observation; do not silently retry or substitute it. Any changed execution or response-validation rule belongs in a separately identified measurement.

The archived hashes establish file integrity and provenance within the supplied evidence. They do not independently authenticate the provider or replace a provider invoice. This package contains no public comparison service and does not enable the optional adapter.
