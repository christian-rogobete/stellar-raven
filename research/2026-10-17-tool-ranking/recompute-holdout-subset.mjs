import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadPackage, check } from './recompute.mjs';

// Contributor disclosure from development records; the archive verifies grades, not this history.
const developmentIds = [
  'q-holdout-a-01-oz-upgrade',
  'q-holdout-a-02-oz-atomic-migration',
  'q-holdout-a-03-oz-cargo',
  'q-holdout-a-04-oz-workspace-setup',
  'q-holdout-a-05-groth16-soroban',
  'q-holdout-a-07-contract-audit-checklist',
  'q-holdout-a-08-contract-security-review',
  'q-holdout-b-01-sep-asset-metadata',
  'q-holdout-b-09-freighter-payment',
  'q-holdout-b-10-nextjs-payment',
  'q-holdout-c-05-oracle-pick',
  'q-holdout-c-06-oracle-tradeoffs',
  'q-holdout-c-17-freighter-nextjs',
  'q-holdout-c-18-dapp-invoke'
];

/** Verify the archived comparison and summarize holdout cases outside the disclosed development set. */
export async function recomputeHoldoutSubset(data, expected) {
  await check(data, expected);
  const omitted = new Set(developmentIds);
  assert.equal(omitted.size, 14, 'Expected 14 distinct development IDs');
  const rows = [];
  for (const repetition of [1, 2]) {
    const holdout = expected.pairs.filter(pair => pair.round === repetition && pair.caseKey.startsWith('holdout:'));
    assert.equal(holdout.length, 49, `Expected 49 holdout cases in repetition ${repetition}`);
    const remaining = holdout.filter(pair => !omitted.has(pair.caseKey.slice('holdout:'.length)));
    assert.equal(remaining.length, 35, `Expected 35 remaining cases in repetition ${repetition}`);
    for (const arm of ['original', 'jev']) {
      const total = name => remaining.filter(pair => pair[arm].metrics[`official.${name}`].value === true).length;
      rows.push({ repetition, arm, questions: remaining.length, top1: total('top1'), top5: total('top5'),
        pass: total('pass'), excluded: total('forbiddenCapture') });
    }
  }
  return { developmentIds: [...developmentIds], rows };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 2, 'Usage: node research/2026-10-17-tool-ranking/recompute-holdout-subset.mjs');
  const { data, expected } = loadPackage();
  console.log(JSON.stringify(await recomputeHoldoutSubset(data, expected), null, 2));
}
