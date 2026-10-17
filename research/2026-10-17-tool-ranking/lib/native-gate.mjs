// Upstream eval/run-routing.mjs defines these gate checks and messages.
const GATE_EVIDENCE_INPUTS = [
  "catalog/manifest.json",
  "eval/routing-cases.json",
  "eval/skills-cases.json",
  "eval/holdout-cases.json",
];

function gateEvidenceFailures(gateConfig, inputHashes) {
  const failures = [];
  const evidence = gateConfig.evidence;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return ["gates.json evidence is missing — re-baseline with committed input fingerprints and accepted totals"];
  }

  if (!Array.isArray(evidence.inputs)) {
    failures.push("gates.json evidence.inputs must be an array");
  } else {
    const inputs = new Map();
    for (const input of evidence.inputs) {
      if (!input || typeof input.path !== "string" || typeof input.sha256 !== "string") {
        failures.push("gates.json evidence.inputs entries must contain path and sha256 strings");
        continue;
      }
      if (inputs.has(input.path)) failures.push(`gates.json evidence.inputs repeats ${input.path}`);
      inputs.set(input.path, input.sha256);
    }
    for (const path of GATE_EVIDENCE_INPUTS) {
      const expected = inputs.get(path);
      if (!expected) {
        failures.push(`gates.json evidence.inputs is missing ${path}`);
        continue;
      }
      if (!/^[a-f0-9]{64}$/.test(expected)) {
        failures.push(`gates.json evidence.inputs has an invalid SHA-256 for ${path}`);
        continue;
      }
      const actual = inputHashes[path];
      if (actual !== expected) failures.push(`${path} SHA-256 does not match the committed gate evidence — re-baseline gates.json explicitly`);
    }
    for (const path of inputs.keys()) {
      if (!GATE_EVIDENCE_INPUTS.includes(path)) failures.push(`gates.json evidence.inputs contains unexpected path ${path}`);
    }
  }

  const totals = evidence.acceptedTotals;
  for (const lane of ["legacy", "skills", "holdout"]) {
    if (!totals?.[lane] || typeof totals[lane] !== "object" || Array.isArray(totals[lane])) {
      failures.push(`gates.json evidence.acceptedTotals.${lane} is missing`);
    }
  }
  if (evidence.localTrace !== undefined && (typeof evidence.localTrace !== "string" || evidence.localTrace.length === 0)) {
    failures.push("gates.json evidence.localTrace must be a non-empty string when present");
  }
  return failures;
}

/** Evaluate the upstream gate with its exact checks and messages. */
export function nativeGate(inputHashes, g, agg, skillsLane, holdoutLane) {
    const failures = gateEvidenceFailures(g, inputHashes);
    if (g.gradingRule !== "v3-manifest-exposed") {
      failures.push(`gates.json gradingRule "${g.gradingRule}" is not what this runner grades (v3-manifest-exposed) — re-baseline`);
    }
    const o = agg.overall;
    if (o.n !== g.legacy.n) {
      failures.push(`legacy n=${o.n} ≠ baselined n=${g.legacy.n} — denominator changed; re-baseline gates.json explicitly`);
    } else {
      const band = Math.round((g.legacy.n * g.legacy.bandPct) / 100);
      for (const k of ["top1", "top3", "top5"]) {
        if (Math.abs(o[k] - g.legacy[k]) > band) failures.push(`legacy ${k}=${o[k]} outside ±${band} of baseline ${g.legacy[k]}`);
      }
    }
    if (!skillsLane) {
      failures.push("skills lane absent (eval/skills-cases.json missing) — the skills gate cannot be evaluated");
    } else if (skillsLane.n !== g.skills.n) {
      failures.push(`skills lane n=${skillsLane.n} ≠ baselined n=${g.skills.n} — re-baseline gates.json explicitly`);
    } else if (skillsLane.top1 < g.skills.minTop1) {
      failures.push(`skills lane top-1=${skillsLane.top1} below floor ${g.skills.minTop1}`);
    }
    // Holdout: a no-regression vector, not a target. Each rank floor and the forbidden-capture
    // ceiling are checked SEPARATELY so a gain in one metric cannot pay for damage in another —
    // the failure this lane exists to catch is a scorer change that rescues one skill family by
    // capturing another's territory, which a single combined score would hide. No ±band: at n=49
    // one case is 2% of the denominator, so slack here would swallow real movement. These floors
    // are the frozen first measurement; moving them is a re-baseline like any other.
    if (g.holdout) {
      if (!holdoutLane) {
        failures.push("holdout lane absent (eval/holdout-cases.json missing) — the holdout gate cannot be evaluated");
      } else if (holdoutLane.n !== g.holdout.n) {
        failures.push(`holdout lane n=${holdoutLane.n} ≠ baselined n=${g.holdout.n} — the frozen set changed; re-baseline gates.json explicitly`);
      } else {
        for (const [k, floor] of [["top1", g.holdout.minTop1], ["top3", g.holdout.minTop3], ["top5", g.holdout.minTop5]]) {
          if (holdoutLane[k] < floor) failures.push(`holdout lane ${k}=${holdoutLane[k]} below floor ${floor}`);
        }
        if (holdoutLane.forbiddenCaptures > g.holdout.maxForbiddenCaptures) {
          failures.push(`holdout forbidden captures=${holdoutLane.forbiddenCaptures} above ceiling ${g.holdout.maxForbiddenCaptures}`);
        }
      }
    }
    return {
      pass: failures.length === 0,
      failures,
      holdoutChecked: Boolean(g.holdout && holdoutLane),
      baselinedAt: g.baselinedAt,
      evidence: g.evidence,
    };
}
