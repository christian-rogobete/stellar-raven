import { isDeepStrictEqual } from 'node:util';
import * as grade from './grade.mjs';
import { nativeGate } from './native-gate.mjs';
const LANES = ["legacy", "extended", "skills", "holdout", "protocolHistory"];
const CASE_FIELDS = ["cases", "extendedCases", "skillsCases", "holdoutCases", "protocolHistoryCases"];
const anyView = (r) => r.any1 === undefined ? r : {
  expected_service: r.expected_service, top1: r.any1, top3: r.any3, top5: r.any5, cardHit5: r.cardHit5,
};

function validateCatalog(records, catalog, grade, protocol) {
  const searchableEntries = catalog.entries.filter((e) => e.searchable !== false && e.kind !== "skill-section");
  for (const { label: c } of records.filter((r) => r.lane === "holdout")) {
    for (const card of [...c.expected_cards, ...c.forbidden_cards]) {
      const matches = searchableEntries.filter((entry) => grade.cardMatchesExact(card, entry));
      if (matches.length !== 1) {
        throw new Error(`holdout card "${card}" resolves to ${matches.length} searchable catalog entries (case ${c.id})`);
      }
    }
  }
  const target = catalog.entries.filter((entry) => entry.id === protocol.targetOperation && entry.searchable !== false);
  if (target.length !== 1 || target[0]?.kind !== "operation") {
    throw new Error(`protocol-history target "${protocol.targetOperation}" resolves to ${target.length} searchable operation entries`);
  }
}

function holdoutGrade(c, hits, cardMatchesExact) {
  const expectedIndex = hits.findIndex((hit) => c.expected_cards.some((card) => cardMatchesExact(card, hit)));
  const expectedRank = expectedIndex === -1 ? null : expectedIndex + 1;
  const forbiddenHits = hits
    .filter((hit) => c.forbidden_cards.some((card) => cardMatchesExact(card, hit)))
    .map((hit) => hit.id);
  const top1 = expectedRank === 1;
  const top3 = expectedRank !== null && expectedRank <= 3;
  const top5 = expectedRank !== null && expectedRank <= 5;
  const forbiddenCapture = forbiddenHits.length > 0;
  return {
    id: c.id, expected_service: c.expected_service,
    expected_cards: c.expected_cards, forbidden_cards: c.forbidden_cards,
    expectedRank, top1, top3, top5, cardHit5: top5, forbiddenCapture, forbiddenHits,
    pass: top5 && !forbiddenCapture,
  };
}

function descriptiveGrade(record, hits, grade) {
  const c = record.label;
  const exact = record.lane === "holdout";
  const protocol = record.lane === "protocolHistory";
  const cards = (c.expected_cards ?? []).filter((card) => !grade.isServiceLevelCard(card));
  const first = (test) => {
    const index = hits.findIndex(test);
    return index < 0 ? null : index + 1;
  };
  const cardRank = protocol ? null : cards.length ? first((hit) => cards.some((card) =>
    (exact ? grade.cardMatchesExact : grade.cardMatches)(card, hit))) : null;
  const firstRelevantRank = protocol ? (c.role === "positive" ? first((h) => h.id === c.targetOperation) : null)
    : exact ? cardRank : first((h) => h.service === c.expected_service);
  return {
    firstRelevantRank,
    relevanceBasis: protocol ? (c.role === "positive" ? "target-operation" : "not-applicable-control")
      : exact ? "exact-card" : "strict-service",
    cardBasis: protocol || !cards.length ? "not-applicable" : exact ? "exact" : "upstream-tolerant",
    cardRank,
    ...Object.fromEntries([1, 3, 5].map((k) => [`cardAt${k}`, protocol || !cards.length ? null : cardRank !== null && cardRank <= k])),
  };
}

function protocolSummary(rows, diagnostic) {
  const positives = rows.filter((c) => c.role === "positive");
  const controls = rows.filter((c) => c.role === "control");
  const lane = {
    contract: diagnostic.contract, frozen: diagnostic.frozen, authoredAt: diagnostic.authoredAt,
    targetOperation: diagnostic.targetOperation, positives: positives.length,
    top1: positives.filter((c) => c.targetRank === 1).length,
    top3: positives.filter((c) => c.targetRank !== null && c.targetRank <= 3).length,
    top5: positives.filter((c) => c.targetRank !== null && c.targetRank <= 5).length,
    controls: controls.length,
    controlTop5Captures: controls.filter((c) => c.targetRank !== null && c.targetRank <= 5).length,
  };
  lane.pass = lane.top5 === lane.positives && lane.controlTop5Captures === 0;
  return lane;
}

function describeLane(rows) {
  const values = rows.map((r) => r.descriptive);
  return {
    n: values.length,
    firstRelevantRanks: rows.map((r) => ({ key: r.key, rank: r.descriptive.firstRelevantRank, basis: r.descriptive.relevanceBasis })),
    cardN: values.filter((v) => v.cardAt5 !== null).length,
    ...Object.fromEntries([1, 3, 5].map((k) => [`cardAt${k}`, values.filter((v) => v[`cardAt${k}`] === true).length])),
  };
}


/** Bind the archived effective labels and source fingerprints to the original grader. */
export function createRoutingGrader(data, records, catalog) {
  const { compiled, skills, holdout, protocol, gates, overlay, inputFingerprints } = data.routing;
  const overlayById = new Map(overlay), warnings = [], repo = inputFingerprints;
  const manifestSha256 = data.provenance.manifestSha256;
  const acceptedManifestFingerprint = gates.evidence.inputs.find(input => input.path === 'catalog/manifest.json').sha256;
  validateCatalog(records, catalog, grade, protocol);
  const byKey = new Map(records.map((record) => [record.key, record]));
  const validateRecord = (record) => {
    if (!isDeepStrictEqual(byKey.get(record.key), record)) throw new Error(`Unbound routing record ${record.key}`);
  };

  /** Grade one ordered top-five list without searching or writing artifacts. */
  function gradeRecord(record, hits) {
    validateRecord(record);
    if (!Array.isArray(hits) || hits.length > 5) throw new Error(`Expected at most five hits for ${record.key}`);
    const c = record.label;
    let official;
    if (record.lane === "holdout") official = holdoutGrade(c, hits, grade.cardMatchesExact);
    else if (record.lane === "protocolHistory") {
      const index = hits.findIndex((hit) => hit.id === protocol.targetOperation);
      official = {
        id: c.id, class: c.class, role: c.role, targetRank: index === -1 ? null : index + 1,
        ...(c.sourceCase ? { sourceCase: c.sourceCase } : {}),
      };
    } else official = {
      id: c.id, expected_service: c.expected_service,
      ...(c.expected_any ? { expected_any: c.expected_any } : {}),
      ...grade.gradeCase(hits, c.expected_service, c.expected_cards, c.expected_any),
    };
    official.topHits = hits.map((h) => ({ id: h.id, service: h.service, score: h.score }));
    return { key: record.key, lane: record.lane, id: record.id, official, descriptive: descriptiveGrade(record, hits, grade) };
  }

  function completeResults(results) {
    if (results.length !== records.length) throw new Error(`Expected ${records.length} results, received ${results.length}`);
    const seen = new Set();
    for (const r of results) {
      const record = byKey.get(r.key);
      if (!record || r.lane !== record.lane || r.id !== record.id || seen.has(r.key)) throw new Error(`Invalid or duplicate result ${r.key}`);
      seen.add(r.key);
      const expected = gradeRecord(record, r.official.topHits);
      if (!isDeepStrictEqual(r, expected)) throw new Error(`Grade does not match hits for ${r.key}`);
    }
    const resultByKey = new Map(results.map((r) => [r.key, r]));
    return records.map((r) => resultByKey.get(r.key));
  }

  /** Preserve the official per-lane denominators and report descriptive metrics separately. */
  function aggregateRecords(results) {
    const ordered = completeResults(results);
    const rows = Object.fromEntries(LANES.map((lane) => [lane, ordered.filter((r) => r.lane === lane).map((r) => r.official)]));
    const agg = grade.aggregate(rows.legacy);
    const extended = grade.aggregate(rows.extended);
    const skillsLane = { authoredAt: skills.authoredAt, ...grade.aggregate(rows.skills).overall };
    const holdoutLane = {
      authoredAt: holdout.authoredAt, ...grade.aggregate(rows.holdout).overall,
      forbiddenCaptures: rows.holdout.filter((r) => r.forbiddenCapture).length,
      passed: rows.holdout.filter((r) => r.pass).length,
    };
    const overlayReport = (cases) => {
      const selected = cases.filter((r) => overlayById.has(r.id));
      return { n: selected.length, strict: grade.aggregate(selected).overall, acceptEither: grade.aggregate(selected.map(anyView)).overall };
    };
    const official = {
      gradingRule: "v3-manifest-exposed",
      casesFile: {
        ...(compiled.generatedAt !== undefined ? { generatedAt: compiled.generatedAt } : {}),
        source: compiled.source, counts: compiled.counts,
      },
      overall: agg.overall, perService: agg.perService,
      acceptEitherOverall: grade.aggregate(rows.legacy.map(anyView)).overall,
      skipped: compiled.counts.skipReasonCounts,
      extendedLane: { strict: extended.overall, perService: extended.perService, acceptEither: grade.aggregate(rows.extended.map(anyView)).overall },
      skillsLane, holdoutLane, protocolHistoryLane: protocolSummary(rows.protocolHistory, protocol),
      overlay: {
        cases: [...overlayById].map(([id, expected_any]) => ({ id, expected_any })),
        legacy: { ...overlayReport(rows.legacy), overallAcceptEither: grade.aggregate(rows.legacy.map((r) => overlayById.has(r.id) ? anyView(r) : r)).overall },
        extended: overlayReport(rows.extended),
      },
      ...Object.fromEntries(LANES.map((lane, i) => [CASE_FIELDS[i], rows[lane]])),
      gate: nativeGate(repo, gates, agg, skillsLane, holdoutLane),
    };
    const band = Math.round(gates.legacy.n * gates.legacy.bandPct / 100);
    return {
      official,
      descriptive: Object.fromEntries(LANES.map((lane) => [lane, describeLane(ordered.filter((r) => r.lane === lane))])),
      positiveBandExceedances: ["top1", "top3", "top5"].filter((k) => agg.overall[k] - gates.legacy[k] > band)
        .map((metric) => ({ lane: "legacy", metric, observed: agg.overall[metric], baseline: gates.legacy[metric], band })),
      manifestSha256, acceptedManifestFingerprint, acceptedManifestMatches: manifestSha256 === acceptedManifestFingerprint,
    };
  }

  /** Compare both complete arms by lane and list every graded or ranking difference. */
  function compare(originalResults, jevResults) {
    const original = completeResults(originalResults);
    const jev = completeResults(jevResults);
    const changes = [];
    for (let i = 0; i < original.length; i++) {
      const a = original[i];
      const b = jev[i];
      const fields = Object.keys(a.official).filter((key) => typeof a.official[key] === "boolean" || key.endsWith("Rank"));
      const grades = fields.filter((key) => a.official[key] !== b.official[key])
        .map((metric) => ({ metric, original: a.official[metric], jev: b.official[metric] }));
      const rankedIds = (r) => r.official.topHits.map((h) => h.id);
      const rankChanged = !isDeepStrictEqual(rankedIds(a), rankedIds(b));
      const jevScores = new Map(b.official.topHits.map((h) => [h.id, h.score]));
      const scoreChanged = a.official.topHits.some((h) => jevScores.has(h.id) && h.score !== jevScores.get(h.id));
      if (grades.length || rankChanged || scoreChanged) changes.push({
        key: a.key, lane: a.lane, id: a.id, grades, rankChanged, scoreChanged,
        originalIds: rankedIds(a), jevIds: rankedIds(b),
        descriptive: { original: a.descriptive, jev: b.descriptive },
      });
    }
    return {
      original: aggregateRecords(original), jev: aggregateRecords(jev),
      lanes: Object.fromEntries(LANES.map((lane) => [lane, {
        n: records.filter((r) => r.lane === lane).length,
        changes: changes.filter((c) => c.lane === lane),
      }])),
    };
  }


  return { records, gradeRecord, compare, manifestSha256, acceptedManifestFingerprint, warnings };
}
