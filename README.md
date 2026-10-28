# OpenVibe.Zone

## Purpose

Private S3-compatible storage zones for OpenVibe projects, at https://openvibe.zone. The design is ADR-031 in
OpenVibe.Contracts, with its amendments of 2026-10-02 and 2026-10-14.

A **zone** is a named object zone of one project environment, sandbox or production. Any S3 tool reaches it as a
bucket at `https://s3.openvibe.media`, path style. That name is DNS-only, so an object may be larger than the 100 MB a
request Cloudflare's proxy carries; `https://s3.openvibe.network` is the same surface behind Cloudflare.

## Owns

The zone record:
- its name, which is never reused;
- its environment, state, description and per-zone quota;
- the control API and the console;
- its metered usage as Media reports it (`zone_usage`).

## Does not own

**OpenVibe.Media owns** everything inside a zone:
- the objects, their bytes and replicas;
- the S3 and native data APIs;
- the access keys;
- quota enforcement, usage counting and the one deletion path.

Zone never lists keys, never holds bytes and never counts.

## Depends on

- **OpenVibe.Media:** provisioning (`PUT /internal/zones/:id`), each zone's report (usage snapshot, deletion progress) and the access keys, on loopback with Zone's own service token.
- **OpenVibe.Network:** sign-in for the console (OAuth with PKCE), a person's projects and roles, and the keys that verify tokens.
- **OpenVibe.Events:** Media's hourly rollups, `media.usage.recorded`, delivered to `POST /internal/events` (subscription made at boot).
- **OpenVibe.Services:** reads the resource index and sends control requests.

## What it does

- **Default zones.** Every project environment has a `default` zone. Its namespace is the environment root, so it holds the environment's existing objects. Zone creates it the first time the environment is used, and it cannot be deleted on its own.
- **Named zones.** Created by name (3 to 63 of `a-z`, `0-9` and `-`), with an optional quota.
  - A name belongs to one zone of its environment for ever: `zone.name_taken` while the zone lives, `zone.name_retired` after it is deleted. So a URL signed for a bucket can never reach a different zone.
  - Named zones are private.
- **Provisioning by revision.** Every change raises the zone's revision and is pushed to Media (`PUT /internal/zones/:id`, capability `media.zone.provision`). Media applies only a higher revision.
  - A zone becomes `active` only after Media has it.
  - The job (`zones.tick`, every 15 s) pushes whatever Media has not acknowledged yet, for example while Media restarts.
- **Deletion.** A zone that still holds objects answers `zone.not_empty`, unless `recursive=true` is sent. A zone with an object under a retention hold answers `zone.held`.
  - Once deletion starts, Media answers `NoSuchBucket` at once, then tombstones and purges every object.
  - When Media reports nothing left, the job marks the zone `deleted`.
  - Media revokes keys scoped only to that zone.
- **Access keys.** The console issues, lists and revokes S3 keys through Media's API (`media.access_key.manage`), for a person who administers the project. A secret is shown once, on the page that issued it.
- **Usage.** Media sends each zone's closed hours as `media.usage.recorded`: requests by capability, read egress, and stored bytes as byte-hours. Zone keeps them; `GET /zones/:zone_id/usage` sums the current UTC month beside Media's live snapshot, and the console shows each zone's requests and egress so far this month.
- **Services.** OpenVibe.Services reaches Zone through two first-party routes:
  - the resource index, `GET /api/v1/resources` (`zone.resource.read`);
  - control, `POST /api/v1/resources/control` (`zone.resource.control`, action `delete`).

## Capabilities and API

Base `https://openvibe.zone/api/v1` (`https://api.openvibe.zone/api/v1` is the same API). A caller is either:
- a developer app of the project, with the route's capability for audience `openvibe.zone` (a sandbox app reaches only the sandbox), or
- a member of the project: any role reads, and admins and owners change.

| Route | Capability |
|---|---|
| `POST /projects/:project_id/zones` (Idempotency-Key) | `zone.zone.create` |
| `GET /projects/:project_id/zones` | `zone.zone.list` |
| `GET /zones/:zone_id` | `zone.zone.read` |
| `PATCH /zones/:zone_id` | `zone.zone.manage` |
| `DELETE /zones/:zone_id?recursive=true` | `zone.zone.delete` |
| `GET /zones/:zone_id/usage` | `zone.usage.read` |
| `GET /resources`, `GET /resources/:ovrn` | `zone.resource.read` (first-party) |
| `POST /resources/control` | `zone.resource.control` (first-party) |

**Grants Zone holds:**
- `media.zone.provision` and `media.access_key.manage` (audience `openvibe.media`);
- `network.project.member.read`;
- `events.subscription.manage` (its `media.usage.recorded` subscription).

## Security

- **Secrets:** an access key's secret is shown once and never stored here (Media keeps it encrypted).
- **Console:** every change is a same-origin form, and only a project's admins and owners change zones and keys.
- **`/internal/`:** answers only on loopback, and nginx answers 404 for it. Deliveries must carry a valid v2 signature (`ZONE_EVENTS_SECRET`), and a request through a proxy is refused.
- **Edge caching:** Media's S3 answers are `private, no-store`, with CDN no-store as well, so no edge keeps them.

## Tests

```sh
npm ci
npm test            # PGlite; npm run test:pg on the PostgreSQL containers
npm run dev
```

`test/zone-api.test.js` runs against a mock Network and a fake Media. It covers:
- default zones, idempotent creation, retired names and provisioning by revision;
- app tokens, roles, updates and deletion;
- the resource index and control;
- the console;
- Media's signed usage rollups.

## Deploy

- Unit `openvibe-zone.service` on 127.0.0.1:5050, database `ov_zone`, env `/etc/openvibe/zone.env` (with `EVENTS_URL` and `ZONE_EVENTS_SECRET` for the usage subscription).
- nginx vhost `deploy/nginx/openvibe.zone.conf`, on openvibe.zone's own certificate.
- `sudo ovhost deploy zone`; migrations run at boot.
- Telemetry: each HTTP request is counted by route template, method and status class, never by raw URL; `/shared`, static assets, health, readiness and `/metrics` are not counted. `server/app.js` builds the collector (`createHttpTelemetry`) and mounts its middleware; `server/index.js` flushes one `http.request` sample per key per minute, plus the active-requests, p95 latency and event-loop-lag gauges, to `telemetry_samples` (openvibe-sdk 0.46, `platform.telemetry-sample@1`), deletes rows older than 14 days daily, and flushes on stop. Created by `migrations/0003_telemetry.sql`.

## Layout

```
server/zone/zones.js     zone records, names, revisions, provisioning, deletion, the job
server/zone/usage.js     Media's hourly rollups, kept and summed
server/zone/clients.js   Media (provision, report, keys) and Network (roles, a person's projects)
server/http/api.js       /api/v1
server/http/events.js    POST /internal/events (v2-signed deliveries, loopback only)
server/http/pages.js     the console and docs; discovery.js robots.txt, sitemap.xml, llms.txt
migrations/              the schema
```

## License

AGPL-3.0, see LICENSE.

<!-- versions:start -->
- openvibe-contracts: v0.222.0
- openvibe-sdk: v0.67.0
- openvibe-shared: v4.22.2
<!-- versions:end -->
