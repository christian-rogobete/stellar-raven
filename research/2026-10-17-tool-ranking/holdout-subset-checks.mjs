import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadPackage } from './recompute.mjs';
import { recomputeHoldoutSubset } from './recompute-holdout-subset.mjs';

const { data, expected } = loadPackage();
const expectedRows = [
  { repetition: 1, arm: 'original', questions: 35, top1: 9, top5: 20, pass: 17, excluded: 8 },
  { repetition: 1, arm: 'jev', questions: 35, top1: 24, top5: 33, pass: 17, excluded: 17 },
  { repetition: 2, arm: 'original', questions: 35, top1: 9, top5: 20, pass: 17, excluded: 8 },
  { repetition: 2, arm: 'jev', questions: 35, top1: 24, top5: 33, pass: 18, excluded: 16 }
];
const moduleUrl = new URL('./recompute-holdout-subset.mjs', import.meta.url);

test('prints the 35-case results and disclosed development IDs for both repetitions', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(moduleUrl)], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.rows, expectedRows);
  assert.equal(new Set(output.developmentIds).size, 14);
  assert(!output.developmentIds.includes('q-holdout-a-06-circom-verifier'));
});

const rejectAlteredGrade = async api => {
  const altered = structuredClone(expected);
  const metric = altered.pairs.find(pair => pair.caseKey.startsWith('holdout:')).original.metrics['official.pass'];
  metric.value = !metric.value;
  await assert.rejects(api.recomputeHoldoutSubset(data, altered), /Recomputed results differ/);
};

test('rejects altered archived grades before reporting subset totals', async () => {
  await rejectAlteredGrade({ recomputeHoldoutSubset });
});

test('counterchecks detect missing selection, repetition, metric, and evidence verification', async () => {
  const source = fs.readFileSync(moduleUrl, 'utf8').replace("'./recompute.mjs'", `'${new URL('./recompute.mjs', moduleUrl).href}'`);
  const totals = async api => assert.deepEqual((await api.recomputeHoldoutSubset(data, expected)).rows, expectedRows);
  await totals({ recomputeHoldoutSubset });
  const mutations = [
    ["!omitted.has(pair.caseKey.slice('holdout:'.length))", 'true', totals],
    ['const repetition of [1, 2]', 'const repetition of [1]', totals],
    ["pass: total('pass')", "pass: total('top5')", totals],
    ['await check(data, expected);', '', rejectAlteredGrade]
  ];
  for (const [before, after, probe] of mutations) {
    assert(source.includes(before), `Mutation anchor missing: ${before}`);
    const mutant = await import(`data:text/javascript;base64,${Buffer.from(source.replace(before, after)).toString('base64')}`);
    await assert.rejects(probe(mutant), assert.AssertionError, `Mutation escaped: ${before}`);
  }
});
