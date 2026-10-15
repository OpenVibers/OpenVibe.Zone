'use strict';

/**
 * OpenVibe.Zone's zones (ADR-031 amendment 2026-10-02). A zone is a named object zone of one project environment; this
 * module owns its record and keeps OpenVibe.Media's projection of it current (clients.provision, by revision).
 *
 *   ensureDefault(project, env)            the environment's `default` zone, created with the first use of it
 *   create(project, body, { caller, idempotencyKey })   → zone.object-zone@1 (provisioning until Media acknowledged)
 *   get(id) / list(project, query)         → zone.object-zone@1 / zone.object-zone-list@1
 *   update(id, body)                       description and quota_bytes (the default zone's quota is the environment's)
 *   remove(id, { recursive })              → the zone in state deleting; Media tombstones and purges its objects
 *   usage(id)                              → zone.object-zone-usage@1 (Media's live snapshot; Zone never counts)
 *   tick()                                 pushes every change Media has not acknowledged, and marks a deleting zone
 *                                          deleted once Media reports nothing left (the job runs it every 15 s)
 *
 * A name belongs to one zone of its environment for ever (409 zone.name_taken while it lives, zone.name_retired once
 * it is deleting or deleted), so a request signed for a bucket can only ever reach the zone it was signed for.
 */
const crypto = require('crypto');
const contracts = require('openvibe-contracts');

const RESERVED = new Set(['default', 'metrics']);
const PAGE = 50;

class ZoneError extends Error {
    constructor(status, code, detail) { super(detail || code); this.status = status; this.code = code; this.detail = detail; }
}
const fail = (status, code, detail) => { throw new ZoneError(status, code, detail); };
const iso = (ms) => (ms == null ? null : new Date(Number(ms)).toISOString());

function createZones({ s, clients, config, log = console, metering = null }) {
    const { db } = s;

    /** The zone.object-zone@1 of a row (usage when given; deletion progress while it is deleting or deleted). */
    function record(row, { usage = null, deletion = null } = {}) {
        const z = {
            id: row.id, project_id: row.project_id, env: row.env, name: row.name, default: !!row.is_default,
            description: row.description ?? null, access: row.is_default ? 'per-object' : 'private', state: row.state,
            quota_bytes: row.quota_bytes == null ? null : Number(row.quota_bytes), revision: Number(row.revision),
            created_at: iso(row.created_at), updated_at: iso(row.updated_at),
        };
        Object.assign(z, contracts.zones.identity(z));
        if (usage) z.usage = { stored_bytes: usage.stored_bytes, objects: usage.objects, as_of: usage.as_of };
        if (row.state === 'deleting' || row.state === 'deleted') {
            z.deletion = {
                requested_at: iso(row.deletion_requested_at),
                objects_remaining: row.state === 'deleted' ? 0 : (deletion ? deletion.objects_remaining : 0),
                held_objects: row.state === 'deleted' ? 0 : (deletion ? deletion.held_objects : 0),
                completed_at: row.state === 'deleted' ? iso(row.deletion_completed_at) : null,
            };
        }
        const check = contracts.zones.checkObjectZone(z);
        if (!check.valid) throw new Error(`zone ${row.id} does not make a valid record: ${JSON.stringify(check.errors).slice(0, 300)}`);
        return z;
    }

    const byId = async (id) => await db.maybe('SELECT * FROM zone_zones WHERE id = $1', [String(id || '')]);

    /** Push a row's current record to Media; pushed_revision follows what Media acknowledged. false when Media refused or is down. */
    async function push(row) {
        try {
            const out = await clients.provision(record(row));
            await db.exec('UPDATE zone_zones SET pushed_revision = GREATEST(pushed_revision, $2) WHERE id = $1', [row.id, row.revision]);
            return out;
        } catch (err) {
            log.warn(`[Zone] Media has not taken ${row.id} r${row.revision} yet (${err.code || err.message}); retried by the job`);
            return null;
        }
    }

    /** provisioning → active once Media holds the zone (two revisions: Media first learns of it, then serves it). */
    async function activate(row) {
        if (row.state !== 'provisioning') return row;
        if (row.pushed_revision < row.revision && !await push(row)) return row;
        const next = await db.maybe(`UPDATE zone_zones SET state = 'active', revision = revision + 1, updated_at = $2
            WHERE id = $1 AND state = 'provisioning' RETURNING *`, [row.id, s.now()]);
        if (!next) return await byId(row.id);
        await push(next);
        return await byId(row.id);
    }

    async function insert(project, env, name, { isDefault = false, description = null, quota = null }) {
        const id = s.newId('zon');
        await db.exec(`INSERT INTO zone_zones (id, project_id, env, name, is_default, description, state, quota_bytes, revision, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, 'provisioning', $7, 1, $8)`, [id, project, env, name, isDefault, description, quota, s.now()]);
        return await activate(await byId(id));
    }

    async function ensureDefault(project, env) {
        const cur = await db.maybe("SELECT * FROM zone_zones WHERE project_id = $1 AND env = $2 AND name = 'default'", [project, env]);
        if (cur) return cur.state === 'provisioning' ? await activate(cur) : cur;
        try { return await insert(project, env, 'default', { isDefault: true }); } catch (err) {
            // Two first uses raced: the other one made it.
            const again = await db.maybe("SELECT * FROM zone_zones WHERE project_id = $1 AND env = $2 AND name = 'default'", [project, env]);
            if (again) return again;
            throw err;
        }
    }

    async function create(project, body = {}, { caller, idempotencyKey = null } = {}) {
        const v = contracts.validate('zone.object-zone-create-request@1', body);
        if (!v.valid) fail(400, 'zone.bad_request', v.errors.map((e) => `${e.path || '/'} ${e.message}`).join('; ').slice(0, 400));
        if (RESERVED.has(body.name)) fail(400, 'zone.name_reserved', `${body.name} is reserved`);
        const digest = crypto.createHash('sha256').update(JSON.stringify([project, body.env, body.name, body.description ?? null, body.quota_bytes ?? null])).digest('hex');
        if (idempotencyKey) {
            const seen = await db.maybe('SELECT digest, zone_id FROM zone_idempotency WHERE caller = $1 AND idempotency_key = $2', [caller, idempotencyKey]);
            if (seen) {
                if (seen.digest !== digest) fail(409, 'zone.idempotency_conflict', 'this Idempotency-Key was used for another request');
                return { zone: record(await byId(seen.zone_id)), repeat: true };
            }
        }
        await ensureDefault(project, body.env);
        const taken = await db.maybe('SELECT state FROM zone_zones WHERE project_id = $1 AND env = $2 AND name = $3', [project, body.env, body.name]);
        if (taken) fail(409, ['deleting', 'deleted'].includes(taken.state) ? 'zone.name_retired' : 'zone.name_taken',
            ['deleting', 'deleted'].includes(taken.state) ? `${body.name} was a zone of this environment; a name is never given to a second zone` : `${body.name} is a zone of this environment already`);
        const count = Number(await db.value("SELECT COUNT(*) FROM zone_zones WHERE project_id = $1 AND env = $2 AND state <> 'deleted' AND NOT is_default", [project, body.env]));
        if (count >= config.maxZonesPerEnv) fail(403, 'zone.quota_exceeded', `an environment holds at most ${config.maxZonesPerEnv} zones besides its default`);
        let row;
        try {
            row = await insert(project, body.env, body.name, { description: body.description ?? null, quota: body.quota_bytes ?? null });
        } catch (err) {
            if (/unique|duplicate/i.test(String(err.message))) fail(409, 'zone.name_taken', `${body.name} is a zone of this environment already`);
            throw err;
        }
        if (idempotencyKey) {
            await db.exec('INSERT INTO zone_idempotency (caller, idempotency_key, digest, zone_id, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
                [caller, idempotencyKey, digest, row.id, s.now()]);
        }
        return { zone: record(row), repeat: false };
    }

    async function get(id, { withUsage = false } = {}) {
        const row = await byId(id);
        if (!row) fail(404, 'zone.unknown', 'no such zone');
        if (!withUsage) return { row, zone: record(row) };
        const rep = row.state === 'deleted' ? null : await clients.report(row.id).catch(() => null);
        return { row, zone: record(row, { usage: rep && rep.usage, deletion: rep && rep.deletion }) };
    }

    async function list(project, query = {}) {
        const v = contracts.validate('zone.object-zone-list-query@1', query);
        if (!v.valid) fail(400, 'zone.bad_request', v.errors.map((e) => `${e.path || '/'} ${e.message}`).join('; ').slice(0, 400));
        const limit = Number(query.limit || PAGE);
        const includeDeleted = query.include_deleted === true || query.include_deleted === 'true';
        let after = '';
        if (query.cursor) {
            try { after = Buffer.from(String(query.cursor), 'base64url').toString('utf8'); } catch { after = ''; }
            if (!/^(sandbox|production)\|[a-z0-9-]{3,63}$/.test(after)) fail(400, 'zone.bad_request', 'cursor is the next_cursor of a previous page');
        }
        const rows = await db.many(`SELECT * FROM zone_zones WHERE project_id = $1 AND ($2::text IS NULL OR env = $2)
            AND ($3 OR state <> 'deleted') AND (env || '|' || name) > $4 ORDER BY env || '|' || name LIMIT $5`,
        [project, query.env || null, includeDeleted, after, limit + 1]);
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return { zones: page.map((r) => record(r)), next_cursor: rows.length > limit && last ? Buffer.from(`${last.env}|${last.name}`).toString('base64url') : null };
    }

    async function update(id, body = {}) {
        const v = contracts.validate('zone.object-zone-update-request@1', body);
        if (!v.valid) fail(400, 'zone.bad_request', v.errors.map((e) => `${e.path || '/'} ${e.message}`).join('; ').slice(0, 400));
        const row = await byId(id);
        if (!row || row.state === 'deleted') fail(404, 'zone.unknown', 'no such zone');
        if (row.state === 'deleting') fail(409, 'zone.deleting', 'the zone is being deleted');
        if (row.is_default && body.quota_bytes !== undefined) fail(409, 'zone.default', 'the default zone is the environment: its quota is the environment\'s');
        const description = body.description !== undefined ? body.description : row.description;
        const quota = body.quota_bytes !== undefined ? body.quota_bytes : row.quota_bytes;
        const next = await db.maybe(`UPDATE zone_zones SET description = $2, quota_bytes = $3, revision = revision + 1, updated_at = $4
            WHERE id = $1 RETURNING *`, [id, description, quota, s.now()]);
        await push(next);
        return record(await byId(id));
    }

    async function remove(id, { recursive = false } = {}) {
        const row = await byId(id);
        if (!row || row.state === 'deleted') fail(404, 'zone.unknown', 'no such zone');
        if (row.is_default) fail(409, 'zone.default', 'the default zone goes only with its environment');
        if (row.state === 'deleting') return record(row);
        const rep = await clients.report(row.id);
        if (rep && rep.deletion == null && rep.usage) {
            if (rep.usage.objects > 0 && !recursive) fail(409, 'zone.not_empty', `the zone holds ${rep.usage.objects} object(s): delete them first, or delete recursively`);
        }
        if (rep) {
            // A held object stays until its hold is released: refused before anything starts (ADR-031 section 10).
            const held = Number(rep.held_objects || 0);
            if (held > 0) fail(409, 'zone.held', `${held} object(s) of the zone are under a retention hold`);
        }
        const now = s.now();
        const next = await db.maybe(`UPDATE zone_zones SET state = 'deleting', revision = revision + 1, updated_at = $2, deletion_requested_at = $2
            WHERE id = $1 AND state IN ('provisioning', 'active') RETURNING *`, [id, now]);
        if (!next) return record(await byId(id));
        await push(next);
        return record(await byId(id), { deletion: { objects_remaining: rep && rep.usage ? rep.usage.objects : 0, held_objects: 0 } });
    }

    async function usage(id) {
        const { row } = await get(id);
        const rep = row.state === 'deleted' ? null : await clients.report(row.id);
        const now = new Date(s.now());
        const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
        const current = rep && rep.usage ? rep.usage : { stored_bytes: 0, objects: 0, as_of: now.toISOString() };
        // The series sums Media's hourly rollups (media.usage.recorded) of this month; window_end is the end of the
        // last hour Media reported (the month's start when none has arrived yet).
        const metered = metering ? await metering.series(row.id, { from: start.getTime() }) : { series: [], reportedUntil: null };
        const out = {
            zone_id: row.id, ovrn: contracts.zones.identity({ ...row, default: row.is_default }).ovrn,
            current: { stored_bytes: current.stored_bytes, objects: current.objects, as_of: current.as_of },
            window_start: start.toISOString(), window_end: new Date(metered.reportedUntil || start.getTime()).toISOString(), series: metered.series,
        };
        return out;
    }

    let ticking = false;
    let lastPrune = 0;
    async function tick() {
        if (ticking) return { pushed: 0, deleted: 0 };
        ticking = true;
        let pushed = 0, deleted = 0;
        try {
            for (const row of await db.many("SELECT * FROM zone_zones WHERE pushed_revision < revision OR state = 'deleting' ORDER BY id LIMIT 200")) {
                if (row.state === 'provisioning') { if ((await activate(row)).state === 'active') pushed++; continue; }
                if (row.pushed_revision < row.revision) { if (await push(row)) pushed++; continue; }
                if (row.state === 'deleting') {
                    const rep = await clients.report(row.id).catch(() => null);
                    if (rep && rep.deletion && rep.deletion.completed_at) {
                        const done = await db.maybe(`UPDATE zone_zones SET state = 'deleted', revision = revision + 1, updated_at = $2, deletion_completed_at = $2
                            WHERE id = $1 AND state = 'deleting' RETURNING *`, [row.id, s.now()]);
                        if (done) { await push(done); deleted++; }
                    }
                }
            }
            if (metering && s.now() - lastPrune > 3600 * 1000) { lastPrune = s.now(); await metering.prune(); }
        } finally { ticking = false; }
        return { pushed, deleted };
    }

    let timer = null;
    function start(ms = 15_000) {
        if (timer) return;
        timer = setInterval(() => { tick().catch((err) => log.warn(`[Zone] tick: ${err.message}`)); }, ms);
        if (timer.unref) timer.unref();
    }
    function stop() { if (timer) clearInterval(timer); timer = null; }

    return { record, byId, ensureDefault, create, get, list, update, remove, usage, tick, start, stop };
}

module.exports = { createZones, ZoneError, RESERVED };
