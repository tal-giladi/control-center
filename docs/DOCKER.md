# Running Control Center in Docker

Nothing is installed on the host: no Node, no npm, no long-lived server process.
The container holds the runtime, and a named docker volume holds the SQLite cache
and the working clone of the data repository.

## One-time setup

1. Create a **private** repository for the data (an empty one is fine) and note
   its HTTPS URL.
2. Create `docker.env` next to `docker-compose.yml`, or point
   `CONTROL_CENTER_ENV_FILE` at a file outside the repository if you would rather
   keep the token off a synced drive:

   ```
   CONTROL_CENTER_GIT_REMOTE=https://github.com/<you>/control-center-data.git
   CONTROL_CENTER_GIT_TOKEN=<a token with write access to that repository only>
   CONTROL_CENTER_GIT_AUTHOR_NAME=<your name>
   CONTROL_CENTER_GIT_AUTHOR_EMAIL=<your email>
   ```

   `docker.env` is ignored by git and excluded from the image.

## Daily use

```bash
docker compose up -d --build     # start (rebuilds when the source changed)
docker compose logs -f           # watch collection and sync
docker compose down              # stop; the volume and its data survive
```

Then open <http://localhost:3000>.

The port is published on `127.0.0.1` only. The app ships without
authentication and rejects any request whose `Host` header is not loopback, so it
stays reachable from your machine and from nowhere else — do not change that
mapping to `0.0.0.0` without putting authentication in front of it.

## Moving to another computer

Install Docker, clone this repository, write the same `docker.env`, and
`docker compose up -d --build`. The container clones the data repository on
startup and rebuilds the database from it, so the dashboard opens with the same
saved items, the same read and archived state, and the same watched sources.

Provider API keys and the Gmail connection are deliberately not in the data
repository and are entered once per machine in Settings.

## Useful checks

```bash
curl http://localhost:3000/api/health          # app health
curl http://localhost:3000/api/git-data        # sync configuration
curl -X POST http://localhost:3000/api/git-data  # force a sync now
```

## Notes

- The collectors run inside the container on a 15-minute timer, starting five
  seconds after boot. Stop the container and nothing collects — that is the
  intended "engine is local" behaviour.
- `docker compose down -v` deletes the volume. That is safe once the first sync
  has pushed: the next start restores everything from the data repository.
