import type { DatabaseSync } from "node:sqlite";
import {
  applyArchiveToPayload,
  type CachedFeedPayload,
} from "./live-response";

export type CollectorCacheKey = "industry" | "mentions" | "newsletters";

function isFeedPayload(value: unknown): value is CachedFeedPayload {
  if (!value || typeof value !== "object") return false;
  const feed = value as Partial<CachedFeedPayload>;
  return Array.isArray(feed.items) &&
    feed.items.every((item) => item && typeof item.id === "string") &&
    (feed.archivedItems === undefined || Array.isArray(feed.archivedItems));
}

export function initializeCollectorCache(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS collector_snapshots (
      collector TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      checked_at TEXT NOT NULL
    );
  `);
  return database;
}

export function writeCollectorSnapshot<T>(
  database: DatabaseSync,
  collector: CollectorCacheKey,
  scope: string,
  payload: T,
  checkedAt = new Date().toISOString(),
) {
  let reconciled = payload;
  if (isFeedPayload(payload) &&
      database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'content_items'").get()) {
    const feed = payload;
    const rows = database.prepare(
      "SELECT external_id, archived_at FROM content_items WHERE category = ?",
    ).all(collector) as unknown as Array<{ external_id: string; archived_at: string | null }>;
    const archivedById = new Map(rows.map((row) => [row.external_id, row.archived_at]));
    let current = feed;
    for (const item of feed.items) {
      const archivedAt = archivedById.get(item.id);
      if (archivedAt) current = applyArchiveToPayload(current, item.id, true, archivedAt);
    }
    for (const item of feed.archivedItems || []) {
      if (item.workflow?.archiveReason === "user" && item.workflow.restoreEligible &&
          archivedById.has(item.id) && !archivedById.get(item.id))
        current = applyArchiveToPayload(current, item.id, false);
    }
    reconciled = current as T;
  }
  database.prepare(`
    INSERT INTO collector_snapshots (collector, scope, payload_json, checked_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (collector) DO UPDATE SET
      scope = excluded.scope,
      payload_json = excluded.payload_json,
      checked_at = excluded.checked_at
  `).run(collector, scope, JSON.stringify(reconciled), checkedAt);
  return reconciled;
}

export function readCollectorSnapshot<T>(
  database: DatabaseSync,
  collector: CollectorCacheKey,
  scope?: string,
) {
  const row = database.prepare(`
    SELECT scope, payload_json, checked_at
    FROM collector_snapshots
    WHERE collector = ?
  `).get(collector) as unknown as
    | { scope: string; payload_json: string; checked_at: string }
    | undefined;
  if (!row || (scope !== undefined && row.scope !== scope)) return null;
  try {
    const payload = JSON.parse(row.payload_json) as T;
    if (!payload || typeof payload !== "object") return null;
    return { scope: row.scope, checkedAt: row.checked_at, payload };
  } catch {
    return null;
  }
}

// Forces the next read of a tab to re-run its collector instead of serving the
// last snapshot. Used when something outside the collection run changes what
// that tab should show.
export function invalidateCollectorSnapshot(
  database: DatabaseSync,
  collector: CollectorCacheKey,
) {
  return Number(
    database.prepare("DELETE FROM collector_snapshots WHERE collector = ?").run(collector).changes,
  ) > 0;
}

export function updateCollectorSnapshotArchive(
  database: DatabaseSync,
  collector: CollectorCacheKey,
  id: string,
  archived: boolean,
  now = new Date().toISOString(),
) {
  const cached = readCollectorSnapshot<CachedFeedPayload>(database, collector);
  if (!cached) return false;
  const next = applyArchiveToPayload(cached.payload, id, archived, now);
  if (next === cached.payload) return false;
  writeCollectorSnapshot(database, collector, cached.scope, next, cached.checkedAt);
  return true;
}
