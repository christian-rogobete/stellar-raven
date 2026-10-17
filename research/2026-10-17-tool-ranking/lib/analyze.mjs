import assert from 'node:assert/strict';
import { isDeepStrictEqual as equal } from 'node:util';
const countBy = (rows, key) => rows.reduce((counts, row) => {
  const name = key(row); counts[name] = (counts[name] ?? 0) + 1; return counts;
}, {});
const ids = page => page.hits.map(hit => hit.id);
const sorted = values => [...values].sort((a, b) => a - b);
const withoutHits = grade => {
  const copy = structuredClone(grade);
  if (copy.official) delete copy.official.topHits;
  return copy;
};
function latency(values) {
  assert(values.every(value => Number.isFinite(value) && value >= 0), 'Invalid resolver duration');
  const ordered = sorted(values);
  const percentile = p => ordered.length ? ordered[Math.max(0, Math.ceil(p * ordered.length) - 1)] : null;
  return { n: ordered.length, p50: percentile(0.5), p95: percentile(0.95), max: ordered.at(-1) ?? null,
    unit: 'milliseconds', scope: 'local-resolver-call', percentileMethod: 'nearest-rank' };
}
function atRanks(rank, applicable, basis) {
  return { basis, rank, ...Object.fromEntries([1, 3, 5].map(k => [`at${k}`, applicable ? rank !== null && rank <= k : null])) };
}
function additionalRanks(record, page) {
  const label = record.label;
  const first = predicate => { const index = page.hits.findIndex(predicate); return index < 0 ? null : index + 1; };
  if (['discovery', 'replay'].includes(record.lane)) {
    const families = label.expectedFamilies ?? [label.expected_service];
    return {
      family: atRanks(first(hit => families.includes(hit.service)), true, 'upstream-expected-families'),
      usableOperation: atRanks(first(hit => (label.acceptableOps ?? []).includes(hit.id)), Boolean(label.acceptableOps?.length), 'upstream-acceptable-operations')
    };
  }
  if (label.targetOperation) return {
    target: { ...atRanks(first(hit => hit.id === label.targetOperation), true, 'ungraded-target-observation'), graded: false, direction: 'not-applicable', role: label.role ?? null }
  };
  const targets = label.first ? [label.first] : label.any ?? label.includes ?? [];
  return { positivePredicateTarget: atRanks(first(hit => targets.includes(hit.id)), targets.length > 0,
    label.first ? 'upstream-first-predicate' : label.any ? 'upstream-any-predicate' : 'upstream-includes-predicate') };
}
function routingRanks(record, grade) {
  const r = grade.official, d = grade.descriptive;
  if (record.lane === 'protocolHistory') return { target: {
    ...atRanks(r.targetRank, true, r.role === 'control' ? 'forbidden-control-target' : 'required-target'),
    direction: r.role === 'control' ? 'lower-is-better' : 'higher-is-better'
  } };
  const rank = atRanks(d.firstRelevantRank, true, d.relevanceBasis);
  return { official: { ...rank, at1: r.top1, at3: r.top3, at5: r.top5 },
    ...(r.any1 === undefined ? {} : { acceptEither: { basis: 'upstream-expected-any', rank: null, at1: r.any1, at3: r.any3, at5: r.any5 } }),
    cards: { basis: d.cardBasis, rank: d.cardRank, at1: d.cardAt1, at3: d.cardAt3, at5: d.cardAt5 } };
}
function metrics(grade, ranks, instrument) {
  const values = {};
  const source = instrument === 'routing' ? grade.official : grade;
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'boolean' && key !== 'graded') values[`official.${key}`] = {
      value, direction: key === 'forbiddenCapture' ? 'lower-is-better' : 'higher-is-better'
    };
  }
  for (const [index, check] of (source.checks ?? []).entries()) {
    values[`predicate.${index}.${check.rule}`] = { value: check.pass, direction: 'higher-is-better' };
  }
  for (const [name, rank] of Object.entries(ranks)) {
    if (rank.graded === false) continue;
    for (const k of [1, 3, 5]) if (typeof rank[`at${k}`] === 'boolean') {
      values[`rank.${name}.at${k}`] = { value: rank[`at${k}`], direction: rank.direction ?? 'higher-is-better' };
    }
  }
  return values;
}
function compareMetrics(original, jev) {
  assert.deepEqual(Object.keys(original), Object.keys(jev), 'Arm metric definitions differ');
  return Object.entries(original).filter(([key, value]) => value.value !== jev[key].value).map(([metric, before]) => {
    const after = jev[metric];
    assert.equal(before.direction, after.direction);
    const gain = before.direction === 'higher-is-better' ? after.value : !after.value;
    return { metric, original: before.value, jev: after.value, direction: before.direction, outcome: gain ? 'gain' : 'loss' };
  });
}
function rankSummary(pairs, arm) {
  const groups = {};
  for (const pair of pairs) for (const [name, row] of Object.entries(pair[arm].ranks)) {
    const bucket = groups[`${name}:${row.basis}:${row.role ?? ''}`] ??= { basis: row.basis, graded: row.graded !== false, direction: row.direction ?? 'higher-is-better',
      n: 0, at1: 0, at3: 0, at5: 0 };
    assert.equal(bucket.basis, row.basis, `Mixed rank basis in ${name}`);
    if (row.at1 === null) continue;
    bucket.n++;
    for (const k of [1, 3, 5]) if (row[`at${k}`]) bucket[`at${k}`]++;
  }
  return groups;
}
function summarizePairs(pairs) {
  const changes = pairs.flatMap(pair => pair.changes.map(change => ({ caseKey: pair.caseKey, ...change })));
  const official = arm => {
    const keys = [...new Set(pairs.flatMap(pair => Object.keys(pair[arm].metrics).filter(key => key.startsWith('official.'))))];
    return Object.fromEntries(keys.map(key => [key, { n: pairs.filter(pair => key in pair[arm].metrics).length,
      true: pairs.filter(pair => pair[arm].metrics[key]?.value === true).length }]));
  };
  return { n: pairs.length,
    original: { ranks: rankSummary(pairs, 'original'), officialBooleanCounts: official('original'), latency: latency(pairs.map(pair => pair.original.resolverCallMs)) },
    jev: { ranks: rankSummary(pairs, 'jev'), officialBooleanCounts: official('jev'), latency: latency(pairs.map(pair => pair.jev.resolverCallMs)) },
    changedIds: pairs.filter(pair => pair.idsChanged).map(pair => pair.caseKey),
    gains: changes.filter(change => change.outcome === 'gain'), losses: changes.filter(change => change.outcome === 'loss'),
    decisions: countBy(pairs, pair => pair.decision.method === 'provider' ? 'provider' : `native:${pair.decision.reason}:${pair.decision.errorCode ?? 'none'}`),
    fallbacks: pairs.filter(pair => pair.expectedProvider && pair.decision.method === 'native').map(pair => ({ caseKey: pair.caseKey, ...pair.decision })),
    bypasses: pairs.filter(pair => !pair.expectedProvider).map(pair => ({ caseKey: pair.caseKey, ...pair.decision })) };
}
function validateRow(row, observation) {
  for (const field of ['sequence', 'caseKey', 'round', 'catalogKey', 'query', 'options', 'armOrder']) assert.deepEqual(row[field], observation[field], `Row ${observation.sequence}: ${field}`);
  assert.deepEqual(Object.keys(row.arms).sort(), ['jev', 'original']);
  assert.deepEqual(row.arms.original.page, observation.nativePage, 'Original differs from frozen page');
  const jev = row.arms.jev;
  if (jev.ranking.method === 'native') assert.deepEqual(jev.page, observation.nativePage, 'Fallback differs from original');
  else {
    assert.equal(jev.ranking.method, 'provider');
    assert.equal(row.providerScores.length, observation.poolIds.length);
    assert.equal(new Set(row.providerScores.map(score => score.id)).size, row.providerScores.length);
    const scoreById = new Map(row.providerScores.map(score => [score.id, score.score]));
    for (const id of observation.poolIds) assert(Number.isFinite(scoreById.get(id)) && scoreById.get(id) >= 0 && scoreById.get(id) <= 1);
    assert([...scoreById.values()].reduce((sum, score) => sum + score, 0) > 0, 'Provider scores have no positive mass');
    const expected = observation.native50.hits.map((hit, index) => ({ hit, index }))
      .sort((a, b) => scoreById.get(b.hit.id) - scoreById.get(a.hit.id) || a.index - b.index)
      .slice(0, observation.nativePage.effectiveLimit).map(item => item.hit);
    assert.deepEqual(jev.page.hits, expected, 'Provider order differs from stored scores');
  }
}

/** Grade only closed, bound observations; incomplete lanes retain individual pairs. */
export function analyzeData(prepared, { summary, completionBinding, rows, inventory }, { routingGrader, additional }) {
  assert(['complete', 'stopped'].includes(summary.status), 'Run has no terminal status');
  for (const key of ['filesMatch', 'nodeMatches', 'preparedMatches', 'candidateDiffMatches']) assert.equal(completionBinding[key], true, `Completion binding: ${key}`);
  const records = new Map(prepared.records.map(record => [record.key, record]));
  assert.equal(records.size, prepared.records.length, 'Duplicate prepared records');
  const routingByKey = new Map(routingGrader.records.map(record => [record.key, record]));
  const additionalByKey = new Map(additional.records.map(record => [record.key, record]));
  for (const record of records.values()) {
    const { instrument, catalogKey, ...core } = record;
    assert(['routing', 'additional'].includes(instrument));
    assert.deepEqual(instrument === 'routing' ? core : { catalogKey, ...core },
      (instrument === 'routing' ? routingByKey : additionalByKey).get(record.key), 'Frozen labels differ from grader');
  }
  assert.equal(prepared.records.length, routingByKey.size + additionalByKey.size, 'Grader population differs');
  const observations = new Map(prepared.observations.map(observation => [observation.sequence, observation]));
  assert.equal(observations.size, prepared.observations.length, 'Duplicate observation sequence');
  const rounds = [...new Set(prepared.observations.map(observation => observation.round))].sort();
  assert.deepEqual(rounds, [1, 2], 'Two bound rounds required');
  for (const round of rounds) {
    const selected = prepared.observations.filter(observation => observation.round === round);
    assert.equal(selected.length, records.size, 'Round population differs');
    assert.deepEqual(selected.map(observation => observation.caseKey).sort(), [...records.keys()].sort(), 'Round case identities differ');
    for (const observation of selected) {
      const record = records.get(observation.caseKey);
      assert.deepEqual(observation.query, record.query); assert.deepEqual(observation.options, record.options);
      assert.equal(observation.catalogKey, record.catalogKey);
    }
  }
  const partition = [...summary.completed, ...summary.incomplete, ...summary.unbegun];
  assert.equal(new Set(partition).size, partition.length, 'Overlapping completion classes');
  assert.deepEqual(sorted(partition), sorted([...observations.keys()]), 'Incomplete completion partition');
  assert.deepEqual(sorted(rows.map(row => row.sequence)), sorted(summary.completed), 'Complete artifacts differ from summary');
  if (summary.status === 'stopped') assert(typeof summary.haltReason === 'string' && summary.haltReason.length > 0, 'Stopped run lacks reason');
  if (summary.status === 'complete') {
    assert.equal(summary.haltReason, null); assert.equal(summary.incomplete.length + summary.unbegun.length, 0);
  }
  const pairs = [];
  for (const row of [...rows].sort((a, b) => a.sequence - b.sequence)) {
    const observation = observations.get(row.sequence); assert(observation, 'Unexpected observation');
    validateRow(row, observation);
    const record = records.get(observation.caseKey), arms = {};
    for (const arm of ['original', 'jev']) {
      const { page, resolverCallMs } = row.arms[arm];
      assert(Number.isFinite(resolverCallMs) && resolverCallMs >= 0);
      const grade = record.instrument === 'routing' ? routingGrader.gradeRecord(routingByKey.get(record.key), page.hits) : additional.gradeRecord(additionalByKey.get(record.key), page);
      const ranks = record.instrument === 'routing' ? routingRanks(record, grade) : additionalRanks(record, page);
      arms[arm] = { ids: ids(page), grade, ranks, metrics: metrics(grade, ranks, record.instrument), resolverCallMs };
    }
    const changes = compareMetrics(arms.original.metrics, arms.jev.metrics);
    pairs.push({ sequence: row.sequence, caseKey: record.key, round: row.round, lane: record.lane, instrument: record.instrument,
      catalogKey: record.catalogKey, query: record.query, options: record.options, label: record.label, source: record.source ?? null,
      preMarkedProblems: (inventory.preMarkedProblems ?? []).filter(problem => problem.id === record.id || problem.id === record.label.id),
      expectedProvider: observation.expectedBody !== null, decision: row.arms.jev.ranking,
      ...arms, changes, idsChanged: !equal(arms.original.ids, arms.jev.ids), gradeChanged: !equal(withoutHits(arms.original.grade), withoutHits(arms.jev.grade)) });
  }
  const resultsByRound = {};
  for (const round of rounds) {
    const inRound = pairs.filter(pair => pair.round === round), lanes = {};
    for (const lane of [...new Set(prepared.records.map(record => record.lane))]) {
      const expectedKeys = prepared.records.filter(record => record.lane === lane).map(record => record.key).sort();
      const selected = inRound.filter(pair => pair.lane === lane), seen = new Set(selected.map(pair => pair.caseKey));
      const missing = expectedKeys.filter(key => !seen.has(key));
      const complete = missing.length === 0 && selected.length === expectedKeys.length;
      lanes[lane] = { complete, expected: expectedKeys.length, received: selected.length, missing,
        aggregate: complete ? summarizePairs(selected) : null };
    }
    const routing = inRound.filter(pair => pair.instrument === 'routing');
    const routingComplete = routing.length === routingGrader.records.length;
    const instruments = Object.fromEntries(['routing', 'additional'].map(instrument => {
      const selected = inRound.filter(pair => pair.instrument === instrument);
      const expected = prepared.records.filter(record => record.instrument === instrument).length;
      return [instrument, { expected, received: selected.length, complete: selected.length === expected,
        aggregate: selected.length === expected ? summarizePairs(selected) : null }];
    }));
    resultsByRound[round] = { lanes, instruments, routing: routingComplete ? routingGrader.compare(routing.map(pair => pair.original.grade), routing.map(pair => pair.jev.grade)) : null };
  }
  const fluctuations = [], unavailable = [];
  for (const record of records.values()) {
    const observationsForCase = rounds.map(round => pairs.find(pair => pair.round === round && pair.caseKey === record.key));
    if (observationsForCase.some(row => !row)) { unavailable.push(record.key); continue; }
    const [a, b] = observationsForCase;
    for (const arm of ['original', 'jev']) {
      const idsChanged = !equal(a[arm].ids, b[arm].ids), gradesChanged = !equal(withoutHits(a[arm].grade), withoutHits(b[arm].grade));
      if (idsChanged || gradesChanged) fluctuations.push({ caseKey: record.key, lane: record.lane, instrument: record.instrument, arm,
        idsChanged, gradesChanged, round1: { ids: a[arm].ids, grade: a[arm].grade }, round2: { ids: b[arm].ids, grade: b[arm].grade } });
    }
  }
  const budget = summary.budget;
  assert(Number.isSafeInteger(summary.physicalAttempts) && summary.physicalAttempts >= 0);
  assert(summary.physicalAttempts <= budget.attempts && budget.attempts <= prepared.limits.maxAttempts, 'Attempt limit mismatch');
  assert(budget.reservedNanoUsd <= prepared.limits.maxReservedNanoUsd, 'Reservation limit mismatch');
  for (const key of ['attempts', 'reservedNanoUsd', 'knownCostAttempts', 'unknownCostAttempts', 'reportedNanoUsd']) assert(Number.isSafeInteger(budget[key]) && budget[key] >= 0, `Invalid cost field ${key}`);
  assert.equal(budget.knownCostAttempts + budget.unknownCostAttempts, budget.attempts);
  return {
    results: { format: 'upstream-comparison-analysis-v1', status: summary.status, haltReason: summary.haltReason,
      completion: { completed: summary.completed, incomplete: summary.incomplete, unbegun: summary.unbegun },
      binding: completionBinding, rounds: resultsByRound,
      costs: { budget, reportedKnownUsd: budget.reportedNanoUsd / 1e9, conservativeReservedUsd: budget.reservedNanoUsd / 1e9,
        unknownCostAttempts: budget.unknownCostAttempts, physicalAttempts: summary.physicalAttempts,
        unknownCostReservedUsd: prepared.limits.maxAttempts ? budget.unknownCostAttempts * (prepared.limits.maxReservedNanoUsd / prepared.limits.maxAttempts) / 1e9 : 0,
        accounting: 'Reported known usage and conservative reservation are separate. Unknown attempts retain their full reservation.' },
      repetition: { comparedCases: records.size - unavailable.length, unavailable, allIdsAndGradesIdentical: unavailable.length ? null : fluctuations.length === 0,
        changedCases: [...new Set(fluctuations.map(row => row.caseKey))], fluctuations },
      preMarkedProblems: inventory.preMarkedProblems ?? [],
      sourceLimits: { freshSourceAvailability: inventory.freshSourceAvailability, sourceEpochs: inventory.sourceEpochs,
        mechanisms: prepared.manifest.metadata?.mechanisms, structuralAssertions: prepared.manifest.metadata?.structuralAssertions },
      latencyScope: 'Local direct resolver calls only. No answer model, MCP transport, or deployed-host timing.' },
    caseDeltas: { format: 'upstream-comparison-case-deltas-v1', pairCount: pairs.length, pairs,
      changedPairs: pairs.filter(pair => pair.idsChanged || pair.gradeChanged).map(pair => pair.sequence) }
  };
}

