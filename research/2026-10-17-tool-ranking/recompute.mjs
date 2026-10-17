import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const range = (first, last) => Array.from({ length: last - first + 1 }, (_, index) => first + index);
const numericBudget = ['attempts', 'reservedInputTokens', 'reservedNanoUsd', 'knownUsageAttempts', 'unknownUsageAttempts',
  'knownCostAttempts', 'unknownCostAttempts', 'reportedInputTokens', 'reportedOutputTokens', 'reportedNanoUsd'];

function item(array, index, name) {
  assert(Number.isInteger(index) && index >= 0 && index < array.length, `Invalid ${name} index: ${index}`);
  return array[index];
}
function expandPage(data, page) {
  return { ...page, hits: page.hits.map(([index, scores]) => {
    const template = item(data.hitTemplates, index, 'hit template');
    const entry = item(data.catalogEntries, template.entry, 'catalog entry');
    return { ...Object.fromEntries(template.inherited.map(key => [key, entry[key]])), ...template.extra, ...scores };
  }) };
}
function recordOf(record) {
  const { originalPage, poolPage, requestSha256, labelQueryFields, ...result } = record;
  result.label = { ...result.label, ...Object.fromEntries(labelQueryFields.map(field => [field, result.query])) };
  return result;
}

/** Render the exact provider request body without credentials or network activity. */
export function buildRequest(data, caseIndex) {
  const record = item(data.cases, caseIndex, 'case');
  if (record.requestSha256 === null) return null;
  const criteria = Object.create(null);
  const hits = expandPage(data, record.poolPage).hits;
  for (const hit of [...hits].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    criteria[hit.id] = `id: ${hit.id}\nservice: ${hit.service}\nkind: ${hit.kind}\ndescription: ${hit.description}\n`;
  }
  return JSON.stringify({ model: data.api.model, state: record.query,
    questions: { tool: { type: 'choice', instructions: data.api.instruction, criteria } } });
}

/** Keep comparison metrics and every case delta while omitting repeated labels and hit descriptions. */
export function projectAnalysis({ results, caseDeltas }) {
  const omitted = new Set(['topHits', 'cases', 'extendedCases', 'skillsCases', 'holdoutCases', 'protocolHistoryCases',
    'inputHashes', 'provenance', 'binding', 'caseAuthoringReceipt']);
  const clean = value => Array.isArray(value) ? value.map(clean) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([key]) => !omitted.has(key)).map(([key, item]) => [key, clean(item)])) : value;
  const projected = clean(results);
  if (projected.sourceLimits?.freshSourceAvailability) {
    const source = projected.sourceLimits.freshSourceAvailability;
    projected.sourceLimits.freshSourceAvailability = { latestRepositoryEvidence: source.latestRepositoryEvidence, snapshotCommitted: source.snapshotCommitted };
  }
  return { results: projected, pairCount: caseDeltas.pairCount,
    pairs: caseDeltas.pairs.map(pair => ({ sequence: pair.sequence, caseKey: pair.caseKey, round: pair.round,
      decision: pair.decision, expectedProvider: pair.expectedProvider, idsChanged: pair.idsChanged, gradeChanged: pair.gradeChanged,
      changes: pair.changes, original: { ids: pair.original.ids, metrics: pair.original.metrics, ranks: pair.original.ranks },
      jev: { ids: pair.jev.ids, metrics: pair.jev.metrics, ranks: pair.jev.ranks } })) };
}

/** Verify the package file hashes and load its archived inputs and archived expectations. */
export function loadPackage(path = directory) {
  const manifest = JSON.parse(fs.readFileSync(join(path, 'manifest.json')));
  for (const [name, digest] of Object.entries(manifest.files)) {
    assert(!name.startsWith('/') && !name.split('/').includes('..'), `Invalid package path: ${name}`);
    assert.equal(hash(fs.readFileSync(join(path, name))), digest, `Package file changed: ${name}`);
  }
  const read = name => JSON.parse(gunzipSync(fs.readFileSync(join(path, name))));
  return { manifest, data: read('data.json.gz'), expected: read('expected.json.gz') };
}

/** Recompute the complete archived comparison with the original grading functions. */
export async function recompute(data) {
  assert.equal(data.format, 'raven-tool-ranking-evidence-v1');
  assert.equal(data.cases.length, 792); assert.equal(data.observations.length, 1584);
  assert.equal(new Set(data.cases.map(record => record.key)).size, 792, 'Duplicate case key');
  assert.deepEqual(data.observations.map(row => row.sequence), range(1, 1584), 'Missing or duplicate observation sequence');
  assert.equal(data.api.model, 'jev-1.14.0');
  const records = data.cases.map(recordOf);
  const catalogs = Object.fromEntries(Object.entries(data.catalogs).map(([key, catalog]) => [key,
    { ...catalog, entries: catalog.entries.map(index => item(data.catalogEntries, index, 'catalog entry')) }]));
  const originals = data.cases.map(record => expandPage(data, record.originalPage));
  const pools = data.cases.map(record => expandPage(data, record.poolPage));
  const requests = data.cases.map((record, index) => {
    assert(pools[index].hits.length <= 50, 'Candidate pool exceeds 50');
    assert.equal(new Set(pools[index].hits.map(hit => hit.id)).size, pools[index].hits.length, 'Duplicate candidate');
    const bypass = !Number.isInteger(originals[index].effectiveLimit) ||
      catalogs[record.catalogKey].entries.some(entry => entry.id === record.query.trim());
    assert.equal(record.requestSha256 === null, bypass || pools[index].hits.length < 2, 'Provider bypass differs');
    const request = buildRequest(data, index);
    assert.equal(request === null ? null : hash(request), record.requestSha256, `Provider input changed: ${record.key}`);
    return request;
  });
  const rows = [], observations = [], segments = data.segments;
  assert.deepEqual(segments.map(segment => segment.assigned), [[1, 79], [80, 673], [674, 1584]]);
  const summed = Object.fromEntries(numericBudget.map(key => [key, 0])); summed.blocked = false;
  let elapsedMs = 0, physicalAttempts = 0, bytesWritten = 0;
  for (const segment of segments) {
    for (const key of ['filesMatch', 'nodeMatches', 'preparedMatches', 'candidateDiffMatches']) assert.equal(segment.completionBinding[key], true);
    const selected = data.observations.filter(row => row.segment === segment.id);
    assert.deepEqual(selected.map(row => row.sequence), range(...segment.assigned), 'Segment population differs');
    assert.deepEqual(segment.summary.completed, range(...segment.assigned));
    assert.deepEqual(segment.summary.incomplete, []);
    assert.deepEqual(segment.summary.unbegun, range(segment.assigned[1] + 1, 1584));
    assert.equal(segment.summary.status, segment.id === 3 ? 'complete' : 'stopped');
    const budget = Object.fromEntries(numericBudget.map(key => [key, 0])); budget.blocked = false;
    let starts = 0;
    for (const observation of selected) {
      const record = item(records, observation.case, 'case'), pool = pools[observation.case], nativePage = originals[observation.case];
      assert.deepEqual(observation.budgetBefore, budget, `Budget before ${observation.sequence}`);
      const raw = observation.transport;
      const physical = raw?.physical === true;
      assert.equal(physical, requests[observation.case] !== null, 'Physical start differs from request eligibility');
      if (physical) {
        starts++;
        assert.equal(observation.request.sha256, data.cases[observation.case].requestSha256);
        assert.equal(observation.request.bytes, Buffer.byteLength(requests[observation.case]));
        budget.attempts++; budget.reservedInputTokens += 65536; budget.reservedNanoUsd += 2752512;
      } else assert.equal(observation.request, null);
      const response = raw?.responseText ? JSON.parse(raw.responseText) : null;
      if (raw?.responseText) assert.equal(hash(raw.responseText), raw.record.bodySha256, 'Raw response hash differs');
      if (response) {
        assert.equal(response.model, data.api.model, 'Response model differs');
        const usage = response.usage;
        assert(Number.isSafeInteger(usage.input_tokens) && Number.isSafeInteger(usage.output_tokens), 'Invalid usage');
        assert(usage.input_tokens >= 0 && usage.input_tokens <= 65536 && usage.output_tokens >= 0, 'Usage outside recorded contract');
        budget.knownUsageAttempts++; budget.knownCostAttempts++;
        budget.reportedInputTokens += usage.input_tokens; budget.reportedOutputTokens += usage.output_tokens;
        budget.reportedNanoUsd += usage.input_tokens * 42;
      }
      budget.unknownUsageAttempts = budget.attempts - budget.knownUsageAttempts;
      budget.unknownCostAttempts = budget.attempts - budget.knownCostAttempts;
      assert.deepEqual(observation.budgetAfter, budget, `Budget after ${observation.sequence}`);
      if (observation.decision.method === 'provider') {
        assert.equal(raw.record.status, 200); assert(response);
        const answer = response.answers.tool;
        assert.equal(answer.probabilities[answer.choice], Math.max(...Object.values(answer.probabilities)), 'Chosen tool is not a probability maximum');
        assert.deepEqual(observation.scores.map(score => score.id), pool.hits.map(hit => hit.id), 'Provider score identities differ');
        for (const score of observation.scores) assert.equal(score.score, response.answers.tool.probabilities[score.id], 'Score differs from raw provider response');
      } else {
        assert.equal(observation.decision.method, 'native');
        assert.equal(observation.scores, null);
        if (physical) {
          assert.equal(observation.decision.reason, 'provider-error');
          if (raw.record.status === 529) { assert.equal(observation.decision.errorCode, 'http-error'); assert.equal(response, null); }
          else {
            assert.equal(raw.record.status, 200); assert.equal(observation.sequence, 673); assert.equal(observation.decision.errorCode, 'response');
            const answer = response.answers.tool;
            assert(answer.probabilities[answer.choice] < Math.max(...Object.values(answer.probabilities)), 'Recorded choice conflict is absent');
          }
        } else assert.equal(observation.decision.reason, pools[observation.case].hits.length < 2 ? 'insufficient-candidates' : 'bypass');
      }
      const common = { sequence: observation.sequence, caseKey: record.key, round: observation.round,
        catalogKey: record.catalogKey, query: record.query, options: record.options, armOrder: observation.armOrder };
      observations.push({ ...common, nativePage, native50: pool, poolIds: pool.hits.map(hit => hit.id), expectedBody: requests[observation.case] });
      rows.push({ ...common, arms: { original: { page: nativePage, resolverCallMs: observation.originalMs },
        jev: { page: expandPage(data, observation.jevPage), resolverCallMs: observation.jevMs, ranking: observation.decision } }, providerScores: observation.scores });
    }
    assert.deepEqual(budget, segment.summary.budget, 'Segment budget differs');
    assert.equal(starts, segment.summary.physicalAttempts);
    for (const key of numericBudget) summed[key] += budget[key];
    summed.blocked ||= budget.blocked; physicalAttempts += starts;
    elapsedMs += segment.summary.elapsedMs; bytesWritten += segment.summary.bytesWritten;
  }
  assert.deepEqual(data.summary.budget, summed, 'Combined budget differs');
  assert.equal(data.summary.physicalAttempts, physicalAttempts);
  assert.equal(data.summary.elapsedMs, elapsedMs); assert.equal(data.summary.bytesWritten, bytesWritten);
  assert.equal(data.summary.status, 'complete'); assert.equal(data.summary.haltReason, null);
  const { createRoutingGrader } = await import('./lib/routing.mjs');
  const { createAdditionalGrader } = await import('./lib/additional.mjs');
  const { analyzeData } = await import('./lib/analyze.mjs');
  const routingRecords = records.filter(record => record.instrument === 'routing').map(({ instrument, catalogKey, ...record }) => record);
  const additionalRecords = records.filter(record => record.instrument === 'additional').map(({ instrument, ...record }) => record);
  const routingGrader = createRoutingGrader(data, routingRecords, catalogs.accepted);
  const additional = createAdditionalGrader(additionalRecords);
  return analyzeData({ records, observations, limits: data.limits, manifest: { metadata: data.metadata } },
    { summary: data.summary, rows, inventory: data.inventory,
      completionBinding: { filesMatch: true, nodeMatches: true, preparedMatches: true, candidateDiffMatches: true } }, { routingGrader, additional });
}

/** Check archived metrics against expectations exported from the separately verified final analysis. */
export async function check(data, expected) {
  const actual = await recompute(data);
  assert.deepEqual(projectAnalysis(actual), expected, 'Recomputed results differ from the archived final analysis');
  return { evidence: 'PASS', cases: data.cases.length, pairs: actual.caseDeltas.pairCount,
    originalQualityGates: [1, 2].map(round => actual.results.rounds[round].routing.original.official.gate.pass),
    jevQualityGates: [1, 2].map(round => actual.results.rounds[round].routing.jev.official.gate.pass) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), { data, expected } = loadPackage();
  if (args.length === 1 && args[0] === '--check') console.log(JSON.stringify(await check(data, expected), null, 2));
  else if (args.length === 2 && args[0] === '--dump' && ['data', 'expected'].includes(args[1])) {
    console.log(JSON.stringify(args[1] === 'data' ? data : expected, null, 2));
  } else if (args.length === 2 && ['--inspect', '--request'].includes(args[0])) {
    const index = data.cases.findIndex(record => record.key === args[1]); assert(index >= 0, `Unknown case: ${args[1]}`);
    if (args[0] === '--request') console.log(buildRequest(data, index) ?? 'null');
    else console.log(JSON.stringify({ case: recordOf(data.cases[index]), originalPage: expandPage(data, data.cases[index].originalPage),
      candidatePool: expandPage(data, data.cases[index].poolPage),
      observations: data.observations.filter(row => row.case === index).map(row => ({ ...row, jevPage: expandPage(data, row.jevPage) })),
      comparison: expected.pairs.filter(pair => pair.caseKey === args[1]) }, null, 2));
  } else throw new Error('Use --check, --inspect CASE_KEY, --request CASE_KEY, or --dump data|expected');
}
