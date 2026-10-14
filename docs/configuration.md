# Configuration

Environment variables for local development, self-hosted servers, and hosted
deployments. Build-time `VITE_*` values are baked into the browser bundle. Server
variables are resolved through the cascade described in
[`database.md`](database.md#credential-cascade-timelines_env_file).

## Variables

| Variable | Purpose |
| --- | --- |
| `TIMELINES_ENV_FILE` | Extra `.env` file paths, separated by `:`. A leading `~/` is expanded. A fresh checkout reads no external file unless this is set. |
| `TIMELINES_DATABASE_URL` | Postgres connection string for the native postgres.js driver. Also enables per-source connections through `TIMELINES_DATABASE_URL_<NAMESPACE>`. |
| `TIMELINES_MIGRATE_DATABASE_URL` | Connection used only for `db:migrate` and `db:check`. A Supabase-backed instance needs it because migrations require a DDL-capable connection. |
| `TIMELINES_SUPABASE_URL` / `TIMELINES_SUPABASE_SERVICE_KEY` | Supabase project URL and service-role key. Used when `TIMELINES_DATABASE_URL` is unset. |
| `TIMELINES_DB_LIVE` | Override for database live updates: `poll` or `realtime`. The configured backend determines the default. |
| `TIMELINES_SERVE_PORT` / `TIMELINES_SERVE_HOST` | Address used by `npm start`. Defaults to `TIMELINES_PORT` or port 3120 on `127.0.0.1`. Bind publicly only behind a proxy. |
| `TIMELINES_DIST_DIR` | Built site served by `npm start`. Defaults to `dist/`. |
| `TIMELINES_TRUSTED_IDENTITY_HEADER` | Request header set by an authenticating proxy. Enabling it requires an identity on every `/api/*` request. The proxy must strip incoming client values for this header. |
| `TIMELINES_ALLOWED_EMAIL_DOMAINS` | Comma-separated identity domains accepted by the self-hosted server — vouched for by the proxy, or proven at the built-in sign-in while `TIMELINES_ACCESS_CONTROL` is disabled. An empty value accepts every identity vouched for by the proxy, and admits nobody at the built-in sign-in. |
| `TIMELINES_SOURCES_SUBDIR` | Restricts local source discovery to `data/<subdir>/`. |
| `TIMELINES_LOCAL_ROOT` | Root directory for local sources. Defaults to `data/` and accepts an absolute path with leading `~` expansion. |
| `TIMELINES_LOCAL_READONLY` | Set to `1` or `true` to refuse writes to every local source. The repository enforces the refusal. |
| `VITE_JIRA_BASE_URL` | Public JIRA base URL used for browse links. An empty value renders issue keys as text. |
| `AUTH_REQUIRED` | `true` enables the Google sign-in gate — on the Netlify edge functions and on `npm start`. The self-hosted gate needs `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `AUTH_SECRET` beside it. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth client (web application type) for the sign-in gate, both runtimes. |
| `AUTH_SECRET` | Random 32+ byte string signing the session cookies, both runtimes. |
| `TIMELINES_ACCESS_CONTROL` | Enables membership-based authorization for sign-in and API requests. Requires a database and a populated member list. See [`users.md`](users.md). |
| `TIMELINES_BOOTSTRAP_ADMIN` | Address promoted to administrator on first sign-in when membership-based authorization is enabled. |
| `ALLOWED_EMAIL_DOMAINS` | Comma-separated sign-in domains accepted by the Netlify gate while `TIMELINES_ACCESS_CONTROL` is disabled. |
| `MCP_API_TOKEN` | Shared secret carried as `X-MCP-Token` by the MCP server; activates the service-token bypass on the Netlify functions and on `npm start`. |
| `MCP_TOKEN_ROLE` | Role assigned to the `X-MCP-Token` service identity. Defaults to `editor`; use `viewer` for read-only access. |
| `MCP_IDENTITY_HEADER` | Name of the header the remote MCP function reads the caller's e-mail address from, for deployments behind a gateway that authenticates users. Unset (the default) keeps the token-only behaviour. See [`mcp.md`](mcp.md). |
| `TIMELINES_DEFAULT_LANGUAGE` | Initial interface language, `de` or `en`, for readers without a stored preference. Defaults to English. |

Instance profiles add the deployment-specific values that select a database,
source directory, build output, and port. Their location and precedence are
documented in [`AGENTS.md`](../AGENTS.md#instances).
