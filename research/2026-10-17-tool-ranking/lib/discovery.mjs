export function expectedFamiliesOf(c) {
  return c.expectedFamilies ?? [c.expected_service];
}

export function gradeVisibleSearches(c, searches) {
  const expectedFamilies = new Set(expectedFamiliesOf(c));
  const acceptableOps = new Set(c.acceptableOps ?? []);
  const familyHitAt3 = searches.some((search) =>
    search.hits.slice(0, 3).some((hit) => expectedFamilies.has(hit.service))
  );
  const usableOpAt5 = c.acceptableOps
    ? searches.some((search) => search.hits.slice(0, 5).some((hit) => acceptableOps.has(hit.id)))
    : null;
  return { familyHitAt3, usableOpAt5 };
}

