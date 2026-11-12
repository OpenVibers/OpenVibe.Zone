# AGENTS.md — OpenVibe.Zone

## Project overview

OpenVibe.Zone (`https://openvibe.zone`) provides private S3-compatible storage **zones** for OpenVibe
projects: one named object zone per project environment (sandbox or production), reached by any S3 tool
at `https://s3.openvibe.media` (path style; `https://s3.openvibe.network` is the same surface behind
Cloudflare). The design is ADR-031. Zone owns the zone record and control API; **Media owns everything
inside a zone**.

- **Entry:** `server/index.js`; app `server/app.js`; port `5050`, service id `zone`.
- **API:** `server/http/api.js` (`/api/v1`), `events.js` (`/internal/events`, v2-signed,
  loopback-only), `pages.js` (console + docs), `discovery.js`, `principal.js`, `caller-limits.js`.
- **Domain:** `server/zone/` — `zones.js` (records, names, revisions, provisioning, deletion, the job),
  `usage.js` (Media's hourly rollups, kept and summed), `clients.js` (Media provision/report/keys and
  Network roles/projects), `media-limits.js`.
- **Pages:** `server/render/` (`layout.js`, `html.js`, `markdown.js`, `short.js`); CSS in `public/css`.
  Console changes are same-origin forms; no SPA.
- **Secrets:** an access key's secret is shown once and never stored here (Media keeps it encrypted).

## Owns, does not own

Owns the zone record: its name (never reused), environment, state, description, per-zone quota; the
control API and console; its metered usage as Media reports it (`zone_usage`); the resource index/control
views. Tables in `ov_zone` (migrations below).

Does not own: **Media owns the objects, bytes, replicas, S3/native data APIs, access keys, quota
enforcement, usage counting and the one deletion path.** Zone never lists keys, never holds bytes and
never counts. Identity/projects are Network's; the price comparison is Host's.

## Capabilities and API

Base `https://openvibe.zone/api/v1` (and `https://api.openvibe.zone/api/v1`). A caller is either a
developer app of the project with the route's capability for audience `openvibe.zone` (a sandbox app
reaches only the sandbox), or a project member (any role reads; admins/owners change).

| Route | Capability |
|---|---|
| `POST /projects/:project_id/zones` (Idempotency-Key) | `zone.zone.create` |
| `GET /projects/:project_id/zones` | `zone.zone.list` |
| `GET /zones/:zone_id` | `zone.zone.read` |
| `PATCH /zones/:zone_id` | `zone.zone.manage` |
| `DELETE /zones/:zone_id?recursive=true` | `zone.zone.delete` |
| `GET /zones/:zone_id/usage` | `zone.usage.read` |
| `GET /resources`, `/resources/:ovrn` | `zone.resource.read` (first-party) |
| `POST /resources/control` | `zone.resource.control` (first-party) |

Grants Zone holds: `media.zone.provision` and `media.access_key.manage` (audience `openvibe.media`),
`network.project.member.read`, and `events.subscription.manage` (the `media.usage.recorded`
subscription). SDK `openvibe-sdk/zone` is the client surface.

## Database and migrations

PostgreSQL `ov_zone` through `openvibe-sdk/db` (PgBouncer for the app, owner role for migrations):
`0001` initial, `0002` usage, `0003` telemetry, `0004` account data, `0005`–`0007` sharing/defaults.
Applied at boot; never edit a migration that has run. Telemetry is aggregated by route template,
method and status class (never raw URL), with 14-day retention; `/shared`, static assets, health,
readiness and `/metrics` are not counted.

## Auth and security

Network RS256 JWTs (JWKS) for apps/members; `/internal/events` answers only on loopback (nginx 404s
it), requires a valid v2 signature (`ZONE_EVENTS_SECRET`) and refuses a request through a proxy. Every
console change is a same-origin form; only a project's admins and owners change zones and keys. Media's
S3 answers are `private, no-store` with CDN no-store, so no edge keeps them. Never log or store an
access-key secret; no shared loopback key exists (tested by grep and at runtime). Account export/
deletion covers every table with a person column or exempts it with a reason.

## Deploy

`sudo ovhost deploy zone`: unit `openvibe-zone.service` on `127.0.0.1:5050`, database `ov_zone`, env
`/etc/openvibe/zone.env` (with `EVENTS_URL` and `ZONE_EVENTS_SECRET` for the usage subscription), nginx
`deploy/nginx/openvibe.zone.conf` on openvibe.zone's own certificate; migrations run at boot. Rollback
with `sudo ovhost rollback zone --to <sha>`.

## Commands and tests

```bash
npm ci
npm run dev                  # http://127.0.0.1:5050
npm test                     # every test/*.test.js, temp PGlite + mock Network
npm test -- login            # only matching files
npm run test:pg              # the same on PostgreSQL
```

`test/run.js` uses `openvibe-shared/test-runner`; temp PGlite and an in-process Network mock, never the
network. Coverage includes zone names/revisions/provisioning/deletion, usage rollups, app vs member
authorization, the S3 surface/limits, nginx auth limits, the no-internal-key and secrets checks,
session/redirect security, account data and the pages.

## Conventions and pitfalls

- CommonJS, 4-space indent, single quotes, semicolons; problem+json errors; escaped HTML.
- **Zone is metadata only.** Do not add an object list, byte store, replica, key listing or a second
  delete path — that is Media's, and a duplicate would drift. Operations call Media with Zone's own
  grants.
- **A zone name is never reused**, even after deletion; a rename does not change the S3 bucket identity.
- **The secret is shown once.** A key response may carry it that one time; never persist, log or
  re-render it. Media holds the encrypted key.
- **Idempotency:** create carries `Idempotency-Key`; a retry must return the same zone, not a second one.
- **Sandbox apps reach only the sandbox**, and only their project; a member check is Network's answer,
  never a client claim.
- **The usage is Media's:** keep the `media.usage.recorded` rollups and sum them; never estimate or
  count a byte locally.
- **No SQL migration may block a rollback**, and one with a person column must be covered by account
  data or exempted in `server/account-data.js` with a reason.
