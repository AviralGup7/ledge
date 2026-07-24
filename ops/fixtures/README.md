# Fixture corpus (T-10 ethics law)
- synthetic-first: generators are seeded + deterministic (see ops/tests/perf generators when they land).
- real-file fixtures (OneTab / Session Buddy / Netscape exports) must be sanitized, attribution-logged in
  FIXTURES.md, and privacy-reviewed before merge (Roadmap R-14 gate).
- golden journals/exports are PUBLIC-API test vectors: changing one requires checking A-13 covenant compatibility.
