import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  SELECTION_LIFETIME_MS,
  candidateIds,
  clearCurationSelections,
  initializeCurationStore,
  readCurationBrief,
  readCurationSelections,
  validateCurationSelections,
  writeCurationBrief,
  writeCurationSelections,
  type CurationCandidate,
} from "../lib/curation-store";

function candidate(id: string, title: string): CurationCandidate {
  return {
    id,
    title,
    summary: "A summary.",
    source: "Example",
    url: `https://example.com/${id}`,
    publishedAt: "2026-09-03T08:00:00.000Z",
    localScore: 60,
    localReasons: ["Matched topic"],
    corroboratingSources: ["Example"],
  };
}

function store() {
  const database = initializeCurationStore(new DatabaseSync(":memory:"));
  writeCurationBrief(database, {
    category: "industry",
    generatedAt: "2026-09-03T09:00:00.000Z",
    limit: 30,
    niche: "AI tooling",
    keywords: ["agents"],
    excludedTerms: ["crypto"],
    candidates: [candidate("one", "A launch"), candidate("two", "A funding round")],
  });
  return database;
}

test("the published brief is the pool plus the instructions the model would get", () => {
  const brief = readCurationBrief(store(), "industry");
  assert.equal(brief?.limit, 30);
  assert.equal(brief?.niche, "AI tooling");
  assert.deepEqual(brief?.candidates.map((entry) => entry.id), ["one", "two"]);
});

test("republishing a pool replaces the previous candidates outright", () => {
  const database = store();
  writeCurationBrief(database, {
    category: "industry",
    generatedAt: "2026-09-03T10:00:00.000Z",
    limit: 30,
    niche: "AI tooling",
    keywords: [],
    excludedTerms: [],
    candidates: [candidate("three", "A newer story")],
  });
  assert.deepEqual([...candidateIds(database, "industry")], ["three"]);
});

test("only ids from the current pool are accepted", () => {
  const database = store();
  const selections = validateCurationSelections(
    { selections: [
      { id: "one", score: 90, reason: "Material launch" },
      { id: "ghost", score: 99, reason: "Not in the pool" },
    ] },
    candidateIds(database, "industry"),
    30,
  );
  assert.deepEqual(selections.map((entry) => entry.discoveryId), ["one"]);
});

test("weak and malformed picks are dropped rather than trusted", () => {
  const allowed = new Set(["one", "two"]);
  assert.deepEqual(
    validateCurationSelections({ selections: [
      { id: "one", score: 40, reason: "Below the useful threshold" },
      { id: "two", score: 80, reason: "  " },
      "nonsense",
    ] }, allowed, 30),
    [],
  );
  assert.deepEqual(
    validateCurationSelections({ selections: [
      { id: "two", score: "high", reason: "Wrong type" },
      { id: "one", score: 88, reason: "Kept" },
    ] }, allowed, 30).map((entry) => entry.discoveryId),
    ["one"],
  );
  assert.throws(() => validateCurationSelections({ selections: "no" }, allowed, 30));
  assert.throws(() => validateCurationSelections([], allowed, 30));
});

// Matching the validator the model's own answer goes through: the first entry
// for an id is the one that counts, so a repeated id cannot be used to raise a
// score that was already rejected.
test("the first entry for an id wins and later repeats are ignored", () => {
  assert.deepEqual(
    validateCurationSelections({ selections: [
      { id: "one", score: 90, reason: "First" },
      { id: "one", score: 95, reason: "Repeat" },
    ] }, new Set(["one"]), 30),
    [{ discoveryId: "one", score: 90, reason: "First" }],
  );
  assert.deepEqual(
    validateCurationSelections({ selections: [
      { id: "one", score: 40, reason: "Rejected as weak" },
      { id: "one", score: 95, reason: "Cannot revive it" },
    ] }, new Set(["one"]), 30),
    [],
  );
});

test("scores are clamped and reasons bounded", () => {
  const [selection] = validateCurationSelections(
    { selections: [{ id: "one", score: 4000, reason: "x".repeat(400) }] },
    new Set(["one"]),
    30,
  );
  assert.equal(selection.score, 100);
  assert.equal(selection.reason.length, 240);
});

test("a new set of picks replaces the previous one instead of merging", () => {
  const database = store();
  writeCurationSelections(database, "industry", [
    { discoveryId: "one", score: 90, reason: "Kept" },
    { discoveryId: "two", score: 80, reason: "Dropped next time" },
  ], "claude-code");
  writeCurationSelections(database, "industry", [
    { discoveryId: "one", score: 70, reason: "Rescored" },
  ], "claude-code");

  const current = readCurationSelections(database, "industry");
  assert.deepEqual(current.selections, [{ discoveryId: "one", score: 70, reason: "Rescored" }]);
  assert.equal(current.curator, "claude-code");
});

test("picks older than their lifetime stop being applied", () => {
  const database = store();
  const received = "2026-09-03T09:00:00.000Z";
  writeCurationSelections(database, "industry", [{ discoveryId: "one", score: 90, reason: "Fresh" }], "claude-code", received);
  const stillFresh = Date.parse(received) + SELECTION_LIFETIME_MS - 1_000;
  assert.equal(readCurationSelections(database, "industry", stillFresh).selections.length, 1);
  assert.equal(readCurationSelections(database, "industry", Date.parse(received) + SELECTION_LIFETIME_MS + 1).selections.length, 0);
});

test("clearing the picks returns the tab to the built-in ranking", () => {
  const database = store();
  writeCurationSelections(database, "industry", [{ discoveryId: "one", score: 90, reason: "Pick" }], "claude-code");
  assert.equal(clearCurationSelections(database, "industry"), 1);
  assert.equal(readCurationSelections(database, "industry").selections.length, 0);
});
