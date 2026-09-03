import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

// The mirror turns durable SQLite rows into one committed JSON file per row so a
// second machine can rebuild the same database from a clone. Caches are excluded:
// they are re-derived from the sources on the next collection run and would
// otherwise rewrite most of the tree every cycle.
export const MIRRORED_DATA_DIRECTORY = "data";
// collector_snapshots is the last collection run; curation_candidates and
// curation_briefs are republished on every run from rows that are mirrored
// anyway. The curator's answers in curation_selections are a real decision and
// do travel.
const excludedTables = new Set(["collector_snapshots", "curation_candidates", "curation_briefs"]);
const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const safeSlugPattern = /^[A-Za-z0-9._-]{1,80}$/;

// Only columns that never change for an existing row may pick the shard, or a
// row would move between files on every refresh and churn the git history.
const shardColumnPreference = ["published_at", "occurred_at", "received_at", "first_seen_at"];
const undatedShard = "undated";

export type MirrorTable = {
  name: string;
  columns: string[];
  keyColumns: string[];
  shardColumns: string[];
};

export type MirrorExportResult = {
  written: number;
  removed: number;
  files: string[];
};

type TableInfoRow = { name: string; pk: number };

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && identifierPattern.test(value);
}

export function mirroredTables(database: DatabaseSync): MirrorTable[] {
  const names = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as unknown as Array<{ name: string }>;
  const tables: MirrorTable[] = [];
  for (const { name } of names) {
    if (excludedTables.has(name) || !isIdentifier(name)) continue;
    const info = database.prepare(`PRAGMA table_info(${name})`).all() as unknown as TableInfoRow[];
    const columns = info.map((column) => column.name).filter(isIdentifier);
    if (columns.length !== info.length) continue;
    const keyColumns = info
      .filter((column) => Number(column.pk) > 0)
      .sort((left, right) => Number(left.pk) - Number(right.pk))
      .map((column) => column.name);
    // A row without a primary key has no stable file name, so it cannot be mirrored.
    if (!keyColumns.length) continue;
    tables.push({
      name,
      columns,
      keyColumns,
      shardColumns: shardColumnPreference.filter((column) => columns.includes(column)),
    });
  }
  return tables;
}

export function rowSlug(values: readonly unknown[]) {
  const parts = values.map((value) => (value === null || value === undefined ? "" : String(value)));
  if (parts.length === 1 && safeSlugPattern.test(parts[0])) return parts[0];
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
}

export function rowShard(row: Record<string, unknown>, shardColumns: readonly string[]) {
  for (const column of shardColumns) {
    const value = row[column];
    if (typeof value !== "string" || !value.trim()) continue;
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString().slice(0, 7);
  }
  return undatedShard;
}

export function rowFilePath(table: MirrorTable, row: Record<string, unknown>) {
  return path.posix.join(
    MIRRORED_DATA_DIRECTORY,
    table.name,
    rowShard(row, table.shardColumns),
    `${rowSlug(table.keyColumns.map((column) => row[column]))}.json`,
  );
}

// Column order is fixed so an unchanged row always serializes byte-for-byte the
// same and produces no diff.
function serializeRow(table: MirrorTable, row: Record<string, unknown>) {
  const ordered: Record<string, unknown> = {};
  for (const column of table.columns) ordered[column] = row[column] ?? null;
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

function listMirroredFiles(root: string) {
  const base = path.join(root, MIRRORED_DATA_DIRECTORY);
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && entry.name.endsWith(".json"))
        found.push(path.relative(root, absolute).split(path.sep).join("/"));
    }
  };
  if (existsSync(base)) walk(base);
  return found;
}

function pruneEmptyDirectories(directory: string) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) pruneEmptyDirectories(path.join(directory, entry.name));
  }
  if (!readdirSync(directory).length) rmSync(directory, { recursive: true, force: true });
}

export function exportDatabaseToFiles(database: DatabaseSync, root: string): MirrorExportResult {
  const expected = new Map<string, string>();
  for (const table of mirroredTables(database)) {
    const rows = database.prepare(`SELECT * FROM ${table.name}`).all() as unknown as Array<Record<string, unknown>>;
    for (const row of rows) expected.set(rowFilePath(table, row), serializeRow(table, row));
  }

  let written = 0;
  for (const [relativePath, contents] of expected) {
    const absolute = path.join(root, relativePath);
    // Rewriting an identical file would still bump its mtime and make every sync
    // cycle look like work, so compare before touching the disk.
    if (existsSync(absolute) && readFileSync(absolute, "utf8") === contents) continue;
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
    written += 1;
  }

  let removed = 0;
  for (const relativePath of listMirroredFiles(root)) {
    if (expected.has(relativePath)) continue;
    rmSync(path.join(root, relativePath), { force: true });
    removed += 1;
  }
  if (removed) pruneEmptyDirectories(path.join(root, MIRRORED_DATA_DIRECTORY));

  return { written, removed, files: [...expected.keys()] };
}

function bindableValue(value: unknown) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" || typeof value === "string") return value;
  return JSON.stringify(value);
}

export function importFilesIntoDatabase(database: DatabaseSync, root: string) {
  const tables = new Map(mirroredTables(database).map((table) => [table.name, table]));
  const statements = new Map<string, ReturnType<DatabaseSync["prepare"]>>();
  let imported = 0;
  let skipped = 0;

  for (const relativePath of listMirroredFiles(root)) {
    const [, tableName] = relativePath.split("/");
    const table = tableName ? tables.get(tableName) : undefined;
    // A file for a table this build does not know about belongs to a newer
    // schema; leaving it untouched keeps the older app from destroying it.
    if (!table) {
      skipped += 1;
      continue;
    }
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(readFileSync(path.join(root, relativePath), "utf8")) as Record<string, unknown>;
    } catch {
      skipped += 1;
      continue;
    }
    if (!row || typeof row !== "object" ||
        table.keyColumns.some((column) => row[column] === undefined || row[column] === null)) {
      skipped += 1;
      continue;
    }
    const columns = table.columns.filter((column) => column in row);
    const cacheKey = `${table.name}:${columns.join(",")}`;
    let statement = statements.get(cacheKey);
    if (!statement) {
      statement = database.prepare(
        `INSERT OR REPLACE INTO ${table.name} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      );
      statements.set(cacheKey, statement);
    }
    statement.run(...columns.map((column) => bindableValue(row[column])));
    imported += 1;
  }

  return { imported, skipped };
}
