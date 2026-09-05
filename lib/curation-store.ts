import type { DatabaseSync } from "node:sqlite";

// An external curator -- an agent, a script, a person -- can do the job the
// configured AI provider would otherwise do. The collector publishes the same
// candidate pool the model would have been given, and the curator posts back
// the same shape of answer, so everything downstream is unchanged.
// Industry hands out a scored candidate pool and takes back a ranking.
// Newsletters hands out prepared email evidence and takes back extracted
// stories; it keeps no pool of its own, because the evidence is re-read from
// Gmail rather than stored.
export type CurationCategory = "industry" | "newsletters";

export type CurationCandidate = {
  id: string;
  title: string;
  summary: string;
  source: string;
  url: string;
  publishedAt: string;
  localScore: number;
  localReasons: string[];
  corroboratingSources: string[];
};

export type CurationSelection = {
  discoveryId: string;
  score: number;
  reason: string;
};

export type CurationBrief = {
  category: CurationCategory;
  generatedAt: string;
  limit: number;
  niche: string;
  keywords: string[];
  excludedTerms: string[];
  candidates: CurationCandidate[];
};

// Selections are answers to one specific pool. A pool published hours ago has
// been replaced by newer collection runs, so an answer to it is stale and the
// local ranking is used instead of silently surfacing yesterday's picks.
export const SELECTION_LIFETIME_MS = 6 * 60 * 60 * 1000;

export function initializeCurationStore(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS curation_candidates (
      category TEXT NOT NULL,
      discovery_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      PRIMARY KEY (category, discovery_id)
    );
    CREATE TABLE IF NOT EXISTS curation_briefs (
      category TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      generated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS curation_selections (
      category TEXT NOT NULL,
      discovery_id TEXT NOT NULL,
      score INTEGER NOT NULL,
      reason TEXT NOT NULL,
      curator TEXT NOT NULL,
      received_at TEXT NOT NULL,
      PRIMARY KEY (category, discovery_id)
    );
  `);
  return database;
}

export function writeCurationBrief(database: DatabaseSync, brief: CurationBrief) {
  const insertCandidate = database.prepare(`
    INSERT INTO curation_candidates (category, discovery_id, payload_json, generated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (category, discovery_id) DO UPDATE SET
      payload_json = excluded.payload_json,
      generated_at = excluded.generated_at
  `);
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare("DELETE FROM curation_candidates WHERE category = ?").run(brief.category);
    for (const candidate of brief.candidates)
      insertCandidate.run(brief.category, candidate.id, JSON.stringify(candidate), brief.generatedAt);
    database.prepare(`
      INSERT INTO curation_briefs (category, payload_json, generated_at)
      VALUES (?, ?, ?)
      ON CONFLICT (category) DO UPDATE SET
        payload_json = excluded.payload_json,
        generated_at = excluded.generated_at
    `).run(
      brief.category,
      JSON.stringify({ limit: brief.limit, niche: brief.niche, keywords: brief.keywords, excludedTerms: brief.excludedTerms }),
      brief.generatedAt,
    );
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function readCurationBrief(database: DatabaseSync, category: CurationCategory): CurationBrief | null {
  const header = database
    .prepare("SELECT payload_json, generated_at FROM curation_briefs WHERE category = ?")
    .get(category) as unknown as { payload_json: string; generated_at: string } | undefined;
  if (!header) return null;
  let options: Pick<CurationBrief, "limit" | "niche" | "keywords" | "excludedTerms">;
  try {
    options = JSON.parse(header.payload_json) as typeof options;
  } catch {
    return null;
  }
  const rows = database
    .prepare("SELECT payload_json FROM curation_candidates WHERE category = ? ORDER BY discovery_id")
    .all(category) as unknown as Array<{ payload_json: string }>;
  const candidates = rows.flatMap((row) => {
    try {
      return [JSON.parse(row.payload_json) as CurationCandidate];
    } catch {
      return [];
    }
  });
  return { category, generatedAt: header.generated_at, ...options, candidates };
}

export function candidateIds(database: DatabaseSync, category: CurationCategory) {
  const rows = database
    .prepare("SELECT discovery_id FROM curation_candidates WHERE category = ?")
    .all(category) as unknown as Array<{ discovery_id: string }>;
  return new Set(rows.map((row) => row.discovery_id));
}

// Posting a new set of picks replaces the previous one outright: a curator that
// drops an item means it should stop being surfaced, not linger from an older run.
export function writeCurationSelections(
  database: DatabaseSync,
  category: CurationCategory,
  selections: readonly CurationSelection[],
  curator: string,
  receivedAt = new Date().toISOString(),
) {
  const statement = database.prepare(`
    INSERT INTO curation_selections (category, discovery_id, score, reason, curator, received_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (category, discovery_id) DO UPDATE SET
      score = excluded.score,
      reason = excluded.reason,
      curator = excluded.curator,
      received_at = excluded.received_at
  `);
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare("DELETE FROM curation_selections WHERE category = ?").run(category);
    for (const selection of selections)
      statement.run(category, selection.discoveryId, selection.score, selection.reason, curator, receivedAt);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return selections.length;
}

export function readCurationSelections(
  database: DatabaseSync,
  category: CurationCategory,
  now = Date.now(),
) {
  const rows = database
    .prepare("SELECT discovery_id, score, reason, curator, received_at FROM curation_selections WHERE category = ?")
    .all(category) as unknown as Array<{ discovery_id: string; score: number; reason: string; curator: string; received_at: string }>;
  const fresh = rows.filter((row) => {
    const received = Date.parse(row.received_at);
    return Number.isFinite(received) && now - received < SELECTION_LIFETIME_MS;
  });
  return {
    curator: fresh[0]?.curator || "",
    receivedAt: fresh[0]?.received_at || "",
    selections: fresh.map((row) => ({
      discoveryId: row.discovery_id,
      score: Math.min(100, Math.max(0, Math.round(Number(row.score)))),
      reason: row.reason,
    })),
  };
}

export function clearCurationSelections(database: DatabaseSync, category: CurationCategory) {
  return Number(database.prepare("DELETE FROM curation_selections WHERE category = ?").run(category).changes);
}

// The same validation the model's own answer goes through: an unknown id, a
// missing reason, or a score below the useful threshold is dropped rather than
// trusted, whoever sent it.
export function validateCurationSelections(
  value: unknown,
  allowedIds: ReadonlySet<string>,
  limit: number,
): CurationSelection[] {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("The curation response must be an object.");
  const selections = (value as { selections?: unknown }).selections;
  if (!Array.isArray(selections)) throw new Error("The curation response must contain a selections list.");
  const seen = new Set<string>();
  return selections.flatMap((entry): CurationSelection[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const item = entry as { id?: unknown; score?: unknown; reason?: unknown };
    if (
      typeof item.id !== "string" ||
      !allowedIds.has(item.id) ||
      seen.has(item.id) ||
      typeof item.score !== "number" ||
      !Number.isFinite(item.score) ||
      typeof item.reason !== "string" ||
      !item.reason.trim()
    ) return [];
    seen.add(item.id);
    return [{
      discoveryId: item.id,
      score: Math.min(100, Math.max(0, Math.round(item.score))),
      reason: item.reason.trim().slice(0, 240),
    }];
  }).filter((entry) => entry.score >= 55).slice(0, Math.max(1, limit));
}
