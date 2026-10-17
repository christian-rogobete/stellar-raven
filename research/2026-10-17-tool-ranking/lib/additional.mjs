import assert from 'node:assert/strict';
import { gradeVisibleSearches } from './discovery.mjs';
function predicateGrade(label, page, hits) {
  const ids = hits.map(hit => hit.id);
  const checks = [];
  for (const id of label.includes ?? []) checks.push({ rule: 'includes', id, pass: ids.includes(id) });
  for (const id of label.excludes ?? []) checks.push({ rule: 'excludes', id, pass: !ids.includes(id) });
  if (label.any) checks.push({ rule: 'any', ids: label.any, pass: label.any.some(id => ids.includes(id)) });
  if (label.first) checks.push({ rule: 'first', id: label.first, pass: ids[0] === label.first });
  for (const [id, tier] of Object.entries(label.tiers ?? {})) {
    checks.push({ rule: 'tier', id, expected: tier, pass: hits.some(hit => hit.id === id && hit.tier === tier) });
  }
  for (const field of ['total', 'truncated']) if (field in label) {
    if (!page || !(field in page)) return { graded: false, pass: null, reason: `missing-page-${field}`, checks };
    checks.push({ rule: field, expected: label[field], actual: page[field], pass: page[field] === label[field] });
  }
  assert.ok(checks.length > 0, 'Predicate labels must contain an assertion');
  return { graded: true, pass: checks.every(check => check.pass), checks };
}


export function createAdditionalGrader(records) {
  function gradeRecord(record, pageOrHits) {
    const page = Array.isArray(pageOrHits) ? null : pageOrHits;
    const rawHits = page ? page.hits : pageOrHits;
    assert.ok(Array.isArray(rawHits),'gradeRecord needs a page or hit array');
    const hits = rawHits.slice(0,record.options.limit);
    if (record.lane === 'protocol-v2-ungraded' || record.label.grading === 'diagnostic-only') {
      const index = hits.findIndex(hit => hit.id === record.label.targetOperation);
      return { graded: false, pass: null, targetRank: index === -1 ? null : index+1,
        reason: record.lane === 'protocol-v2-ungraded' ? 'source-expired-ungraded-observation' : 'diagnostic-only' };
    }
    if (record.lane === 'discovery' || record.lane === 'replay') {
      const result = { graded: true, pass: null, ...gradeVisibleSearches(record.label,[{hits}]) };
      if (record.lane === 'replay') Object.assign(result, {
        familyTop1: record.label.expectedFamilies.includes(hits[0]?.service),
        familyTop5: hits.slice(0,5).some(hit => record.label.expectedFamilies.includes(hit.service)),
        usableOpTop1: record.label.acceptableOps.includes(hits[0]?.id)
      });
      return result;
    }
    return predicateGrade(record.label,page,hits);
  }

  return { records, gradeRecord };
}
