// Settings are split in two: the parts that describe what to watch travel with
// the data repository so a second machine sees the same dashboard, and the
// credentials stay on the machine that owns them and are never written to a file
// that gets committed or pushed.
export const SHARED_SETTINGS_FILE = "settings/shared-settings.json";

const secretPaths: readonly (readonly string[])[] = [
  ["ai", "apiKeys"],
  ["newsletters", "googleClientId"],
  ["newsletters", "googleClientSecret"],
  ["newsletters", "refreshToken"],
  ["newsletters", "accessToken"],
  ["newsletters", "accessTokenExpiresAt"],
];

type Settings = Record<string, unknown>;

function isPlainObject(value: unknown): value is Settings {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deleteAt(target: Settings, keyPath: readonly string[]) {
  let cursor: Settings = target;
  for (const key of keyPath.slice(0, -1)) {
    const next = cursor[key];
    if (!isPlainObject(next)) return;
    cursor = next;
  }
  delete cursor[keyPath[keyPath.length - 1]];
}

export function redactSharedSettings<T extends Settings>(settings: T): Settings {
  const copy = structuredClone(settings) as Settings;
  for (const keyPath of secretPaths) deleteAt(copy, keyPath);
  return copy;
}

export function containsSecrets(settings: unknown) {
  if (!isPlainObject(settings)) return false;
  return secretPaths.some((keyPath) => {
    let cursor: unknown = settings;
    for (const key of keyPath) {
      if (!isPlainObject(cursor)) return false;
      cursor = cursor[key];
    }
    return cursor !== undefined;
  });
}

// Shared values win because they are the ones the other machine just changed;
// arrays are replaced whole so removing a source or a keyword actually removes it.
export function mergeSharedSettings<T extends Settings>(local: T, shared: unknown): T {
  if (!isPlainObject(shared)) return local;
  const merge = (base: unknown, incoming: unknown): unknown => {
    if (!isPlainObject(incoming)) return incoming;
    if (!isPlainObject(base)) return structuredClone(incoming);
    const result: Settings = { ...base };
    for (const [key, value] of Object.entries(incoming)) result[key] = merge(base[key], value);
    return result;
  };
  // A shared file that somehow carries a credential is ignored for that field
  // rather than allowed to overwrite the local one.
  return merge(local, redactSharedSettings(shared)) as T;
}
