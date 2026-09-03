# Git-backed data store

Upstream Control Center keeps everything in one SQLite file in a per-user data
directory. That file never leaves the machine that created it, so a second
computer starts empty and a container starts empty again after every rebuild.

This fork keeps SQLite but demotes it to a rebuildable cache. The source of
truth is a **private git repository** holding one JSON file per row. The engine
still runs locally; only the data lives in the cloud.

## What the app does

On startup, before the first request is served:

1. Clone the data repository into `CONTROL_CENTER_GIT_DIR` (or fetch and reset
   it to the remote branch if the clone already exists).
2. Merge the committed shared settings into the local `settings.json`, leaving
   every locally stored credential untouched.
3. `INSERT OR REPLACE` every committed row back into SQLite.

While running:

- A user action that changes durable state — archiving an item, editing a task
  or reminder, saving settings — schedules a sync five seconds later, so a burst
  of clicks still produces a single commit.
- A background timer syncs every `CONTROL_CENTER_GIT_SYNC_SECONDS` (default 120)
  regardless.
- `POST /api/git-data` forces a sync now; `GET /api/git-data` reports the
  configuration.

Each sync fetches the remote first, imports anything another machine pushed,
exports the database over the working tree, then commits and pushes. The export
is a **full reconciliation**: a file with no matching row is deleted. That is why
the import always runs first — exporting over an unread remote change would
delete that change.

## Layout of the data repository

```
data/<table>/<YYYY-MM>/<row>.json     one file per durable row
settings/shared-settings.json         watched sources, keywords, brief layout
```

The month shard comes from the first stable column the table has, in the order
`published_at`, `occurred_at`, `received_at`, `first_seen_at`; a row with no
usable date lands in `undated/`. Shards are chosen only from columns that never
change for an existing row, so a row never moves between files and the history
stays small. The file name is the row's primary key when that is a single safe
value (`tasks.json`), and a SHA-256 prefix of the key otherwise.

Every table with a primary key is mirrored automatically, including tables added
by a future upstream release. `collector_snapshots` is excluded: it is a cache of
the last collection run, it is re-derived within minutes, and mirroring it would
rewrite most of the tree on every cycle. A file whose table this build does not
recognise is left untouched rather than deleted, so an older container cannot
destroy data written by a newer one.

## What is never committed

`settings/shared-settings.json` is written through a redaction step that removes:

- `ai.apiKeys` — every provider key
- `newsletters.googleClientId`, `newsletters.googleClientSecret`
- `newsletters.refreshToken`, `newsletters.accessToken`,
  `newsletters.accessTokenExpiresAt`

Those stay in the local `settings.json` inside the container volume and must be
entered once per machine. The merge is one-way for them too: a shared file that
somehow carries a credential cannot overwrite the local one.

Everything else — watched sources, keywords, excluded terms, mention terms,
audience accounts, daily-brief sections, the selected AI provider and model —
travels with the repository.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CONTROL_CENTER_GIT_REMOTE` | *(unset)* | Data repository URL. **Unset disables all of this** and the app behaves exactly like upstream. |
| `CONTROL_CENTER_GIT_BRANCH` | `main` | Branch to track. |
| `CONTROL_CENTER_GIT_DIR` | `<data dir>/git-store` | Absolute path of the working clone. |
| `CONTROL_CENTER_GIT_SYNC_SECONDS` | `120` | Background sync interval. |
| `CONTROL_CENTER_GIT_PUSH` | `1` | Set to `0` to commit locally without pushing. |
| `CONTROL_CENTER_GIT_TOKEN` | *(unset)* | Token answered to git's password prompt. |
| `CONTROL_CENTER_GIT_USERNAME` | `x-access-token` | Username answered to git's prompt. |
| `CONTROL_CENTER_GIT_AUTHOR_NAME` / `_EMAIL` | `Control Center` / `control-center@localhost` | Commit identity. |

The token is supplied through a `GIT_ASKPASS` helper, so it never reaches the
remote URL, `.git/config`, the commit, or the argument list of any git command.

## Running it

See [DOCKER.md](DOCKER.md).
