# Connecting a Gmail account

The Newsletters tab reads a Gmail mailbox with a read-only OAuth client that you
create yourself. There is no shared secret shipped with the app and no API key to
buy — you need an **OAuth 2.0 client ID and secret**, which is a different thing
from an API key and cannot be replaced by one.

Budget ten minutes. Every step is in [Google Cloud
Console](https://console.cloud.google.com/).

## 1. Create a project

Top bar → project picker → **New project**. Any name. Select it once it is
created.

## 2. Enable the Gmail API

**APIs & Services → Library** → search `Gmail API` → **Enable**. Nothing else
needs enabling; the sign-in and profile lookup work without a separate API.

## 3. Configure the consent screen

**APIs & Services → OAuth consent screen** (newer consoles call this
**Branding** and **Audience**):

- User type: **External**.
- App name and support email: anything; only you will see this screen.
- Scopes: add `https://www.googleapis.com/auth/gmail.readonly`. The app also
  requests `openid` and `email`, which need no configuration.
- **Leave the app in Testing.** Under **Audience → Test users**, add the Gmail
  address you are going to connect.

**Do not press "Publish app".** `gmail.readonly` is a *restricted* scope: a
published app that Google has not verified is refused at the consent step with
`Error 403: access_denied`. Testing mode is the working configuration for a
personal dashboard. The cost is that Google expires the refresh token after
seven days, so roughly once a week the Newsletters tab asks you to reconnect —
one click, no reconfiguration.

## 4. Create the OAuth client

**APIs & Services → Credentials → Create credentials → OAuth client ID**.

- Application type: **Web application**. Not *Desktop app* — a desktop client
  refuses a redirect URI that has a path, and the sign-in fails immediately with
  `Error 400: invalid_request` naming `redirect_uri`.
- Under **Authorized redirect URIs**, add exactly:

  ```
  http://localhost:3000/api/auth/google/callback
  ```

  No trailing slash. If you run the app on another port, change the port here to
  match. Google matches this string literally.

## 5. Paste the credentials

Open the dashboard at **`http://localhost:3000`** — not `127.0.0.1:3000`. The
app builds its redirect URI from the address in your address bar, and Google
treats the two spellings as different origins.

**Settings → Newsletters** → paste the client ID and client secret → adjust the
Gmail search query if you want → **Save & choose Gmail account**. Pick the
account you added as a test user, and click through the "Google hasn't verified
this app" warning, which is expected for your own unverified client.

## Where the credentials end up

The client ID, client secret, refresh token, and access token are written to
`settings.json` in the data directory (`/data/settings.json` in the container),
owner-readable only. They are **excluded from the git data store on purpose**, so
they never reach a commit and are entered once per machine. See
[GIT_DATA_STORE.md](GIT_DATA_STORE.md).

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `Error 400: invalid_request`, details name `redirect_uri=http://0.0.0.0:3000/...` | You are on a build older than the Host-header fix. Rebuild the image. |
| `Error 400: invalid_request`, details name your real redirect URI | The OAuth client is a *Desktop app*. Recreate it as *Web application*. |
| `Error 400: redirect_uri_mismatch` | The URI in the client does not match character for character — check the port, the trailing slash, and `localhost` vs `127.0.0.1`. |
| `Error 403: access_denied` | The app was published, or the account you chose is not in **Test users**. Set the app back to Testing and add the account. |
| Connection drops after about a week | Expected in Testing mode. Reconnect from Settings → Newsletters. |

## What the app does with the access

Read-only. It never sends, labels, deletes, marks as read, or archives anything.
Newsletter text goes to the AI provider you selected for extraction with email
addresses and subscriber-specific link URLs masked first; raw bodies are not
stored.
