import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadPackage, check, recompute, buildRequest } from './recompute.mjs';

const { data, expected } = loadPackage();
const copy = () => structuredClone(data);

test('reproduces all 1584 pairs while keeping both Jev quality gates failed', async () => {
  assert.deepEqual(await check(data, expected), { evidence: 'PASS', cases: 792, pairs: 1584,
    originalQualityGates: [true, true], jevQualityGates: [false, false] });
  const failures = data.observations.filter(row => row.decision.reason === 'provider-error');
  assert.deepEqual(failures.map(row => row.sequence), [17, 23, 24, 53, 77, 78, 79, 673, 794, 797, 832, 833, 836]);
  assert.equal(data.observations.filter(row => row.request === null).length, 10);
  assert.equal(data.inventory.preMarkedProblems.length, 21);
  assert.equal(expected.results.repetition.comparedCases, 792);
  assert.equal(expected.results.repetition.changedCases.length, 377);
});

test('rejects missing and duplicate observations and duplicate case identities', async () => {
  for (const mutate of [value => value.observations.pop(),
    value => { value.observations[1].sequence = 1; }, value => { value.cases[1].key = value.cases[0].key; }]) {
    const value = copy(); mutate(value); await assert.rejects(recompute(value), assert.AssertionError);
  }
});

test('rejects changed labels against the archived expected metrics', async () => {
  const value = copy(); value.cases[0].label.expected_service = 'stellarDocs';
  await assert.rejects(check(value, expected), /archived final analysis/);
});

test('rejects changed scores, rankings, request descriptions, and response bytes', async () => {
  for (const mutate of [
    value => { value.observations[0].scores[0].score += 0.01; },
    value => value.observations[0].jevPage.hits.reverse(),
    value => { value.catalogEntries[value.hitTemplates[value.cases[0].poolPage.hits[0][0]].entry].description += ' changed'; },
    value => { value.observations[0].transport.responseText += ' '; }
  ]) { const value = copy(); mutate(value); await assert.rejects(recompute(value), assert.AssertionError); }
});

test('rejects changed fallback decisions, restored errors, and altered cost accounting', async () => {
  for (const mutate of [
    value => { value.observations[16].decision.errorCode = 'timeout'; },
    value => { value.observations[672].decision.method = 'provider'; },
    value => { value.observations[0].budgetAfter.reportedNanoUsd++; },
    value => { value.summary.budget.unknownCostAttempts = 0; },
    value => { value.segments[1].completionBinding.filesMatch = false; }
  ]) { const value = copy(); mutate(value); await assert.rejects(recompute(value), assert.AssertionError); }
});

test('renders exact provider inputs and distinguishes all ten bypass observations', () => {
  const body = JSON.parse(buildRequest(data, 0));
  assert.equal(body.model, 'jev-1.14.0'); assert.equal(body.state, data.cases[0].query);
  assert.equal(body.questions.tool.instructions, data.api.instruction);
  assert.deepEqual(Object.keys(body.questions.tool.criteria), [...Object.keys(body.questions.tool.criteria)].sort());
  assert.equal(data.cases.filter((record, index) => buildRequest(data, index) === null).length, 5);
});

test('detects a changed package file before loading evidence', () => {
  const scratch = fs.mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.integrity-test-'));
  try {
    fs.writeFileSync(join(scratch, 'manifest.json'), JSON.stringify({ files: { 'probe.txt': '0'.repeat(64) } }));
    fs.writeFileSync(join(scratch, 'probe.txt'), 'changed');
    assert.throws(() => loadPackage(scratch), /Package file changed: probe.txt/);
  } finally { fs.rmSync(scratch, { recursive: true }); }
});

test('counterchecks detect removed score, error, cost, and archived comparison checks', async () => {
  const moduleUrl = new URL('./recompute.mjs', import.meta.url);
  const source = fs.readFileSync(moduleUrl, 'utf8')
    .replace('const directory = dirname(fileURLToPath(import.meta.url));', `const directory = ${JSON.stringify(dirname(fileURLToPath(moduleUrl)))};`)
    .replace(/import\('(\.\/?[^']+)'\)/g, (_, path) => `import('${new URL(path, moduleUrl).href}')`);
  const mutations = [
    ["for (const score of observation.scores) assert.equal(score.score, response.answers.tool.probabilities[score.id], 'Score differs from raw provider response');", '',
      async api => { const value = copy(); value.observations[0].scores[0].score += 0.000001; await assert.rejects(api.recompute(value), /Score differs/); }],
    ["assert.equal(observation.decision.errorCode, 'http-error');", '',
      async api => { const value = copy(); value.observations[16].decision.errorCode = 'timeout'; await assert.rejects(api.recompute(value), assert.AssertionError); }],
    ["assert.deepEqual(data.summary.budget, summed, 'Combined budget differs');", '',
      async api => { const value = copy(); value.summary.budget.reportedNanoUsd++; await assert.rejects(api.recompute(value), /Combined budget differs/); }],
    ["assert.deepEqual(projectAnalysis(actual), expected, 'Recomputed results differ from the archived final analysis');", '',
      async api => { const value = copy(); value.cases[0].label.expected_service = 'stellarDocs'; await assert.rejects(api.check(value, expected), /archived final analysis/); }]
  ];
  for (const [before, after, probe] of mutations) {
    assert(source.includes(before), `Mutation anchor missing: ${before}`);
    const mutant = await import(`data:text/javascript;base64,${Buffer.from(source.replace(before, after)).toString('base64')}`);
    await assert.rejects(probe(mutant), assert.AssertionError, `Mutation escaped: ${before}`);
  }
});
