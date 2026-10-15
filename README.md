# OpenVibe.Zone

Private S3-compatible storage zones for OpenVibe projects, at https://openvibe.zone. The design is ADR-031 in
OpenVibe.Contracts, with its amendment of 2026-10-02.

A **zone** is a named object zone of one project environment, sandbox or production. Any S3 tool reaches it as a
bucket at `https://s3.openvibe.media`, path style.

**Zone owns** the zone record:
- its name, which is never reused;
- its environment, state, description and per-zone quota;
- the control API and the console.

**OpenVibe.Media owns** everything inside a zone:
- the objects, their bytes and replicas;
- the S3 and native data APIs;
- the access keys;
- quota enforcement, usage counting and the one deletion path.

Zone never lists keys and never holds bytes.

**Usage.** Zone never counts. Media sends each zone's closed hours as `media.usage.recorded`: requests by capability,
read egress, and stored bytes as byte-hours. Zone keeps them (`zone_usage`, delivered signed to `POST /internal/events`,
loopback only). `GET /zones/:zone_id/usage` sums the current UTC month beside Media's live snapshot, and the console
shows each zone's requests and egress so far this month.

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
- **Services.** OpenVibe.Services reaches Zone through two first-party routes:
  - the resource index, `GET /api/v1/resources` (`zone.resource.read`);
  - control, `POST /api/v1/resources/control` (`zone.resource.control`, action `delete`).

## API

Base `https://openvibe.zone/api/v1`. A caller is either:
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

## Run

```sh
npm ci
npm test            # PGlite; npm run test:pg on the PostgreSQL containers
npm run dev
```

**Production:**
- unit `openvibe-zone.service` on 127.0.0.1:5050, database `ov_zone`, env `/etc/openvibe/zone.env`;
- nginx vhost `deploy/nginx/openvibe.zone.conf` on openvibe.zone's own certificate;
- deployed with `sudo ovhost deploy zone`.

**Grants it needs:**
- `media.zone.provision` and `media.access_key.manage` (audience `openvibe.media`);
- `network.project.member.read`.

## Layout

```
server/zone/zones.js     zone records, names, revisions, provisioning, deletion, the job
server/zone/clients.js   Media (provision, report, keys) and Network (roles, a person's projects)
server/http/api.js       /api/v1
server/http/pages.js     the console and docs; discovery.js robots.txt, sitemap.xml, llms.txt
migrations/              the schema
```

## License

AGPL-3.0, see LICENSE.
