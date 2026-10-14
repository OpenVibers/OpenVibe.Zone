'use strict';

/**
 * /api/v1 — OpenVibe.Zone's API (capabilities: openvibe-contracts manifests/capabilities/zone.*; ADR-031 amendment).
 *
 *   GET    /ping                                   public             { ok }
 *   POST   /projects/:project/zones                zone.zone.create   zone.object-zone-create-request@1, Idempotency-Key → 201
 *   GET    /projects/:project/zones                zone.zone.list     ?env&include_deleted&cursor&limit → zone.object-zone-list@1
 *   GET    /zones/:zone                            zone.zone.read     zone.object-zone@1 with Media's live usage
 *   PATCH  /zones/:zone                            zone.zone.manage   description, quota_bytes
 *   DELETE /zones/:zone?recursive=true             zone.zone.delete   202 zone.object-zone@1 (deleting)
 *   GET    /zones/:zone/usage                      zone.usage.read    zone.object-zone-usage@1
 *   GET    /resources[?project&kind&cursor&limit]  zone.resource.read first-party: common.resource-list-result@1
 *   GET    /resources/:ovrn                        zone.resource.read first-party: common.resource-summary@1
 *   POST   /resources/control                      zone.resource.control  first-party: delete, for a project admin
 *
 * Who may act on a project: a developer app of that project holding the route's capability (a sandbox app only in the
 * sandbox), or a person who is a member of it (any role reads; admins and owners change). Anyone else is told the
 * project or zone does not exist.
 */
const crypto = require('crypto');
const express = require('express');
const contracts = require('openvibe-contracts');
const { asyncRouter } = require('./router');
const { ZoneError } = require('../zone/zones');
const { ClientError } = require('../zone/clients');

const PROJECT_RE = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/;
const ZONE_RE = /^zon_[0-9A-HJKMNP-TV-Z]{26}$/;
const USER_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const ADMIN = new Set(['admin', 'owner']);
const KIND = 'zone.object-zone';

function createApi(ctx) {
    const { principal, zones, clients, limits, config } = ctx;
    const r = asyncRouter();
    const json = express.json({ limit: '32kb' });
    const send = (req, res, status, code, detail) => contracts.http.sendProblem(res, status, code, { detail, ctx: req.ov });
    const wrap = (fn) => async (req, res) => {
        try { await fn(req, res); } catch (err) {
            if (err instanceof ZoneError || err instanceof ClientError) return send(req, res, err.status, err.code, err.detail || err.message);
            throw err;
        }
    };
    r.use(principal.middleware);
    r.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    // Every route counts against the caller's read numbers first; the writes and the reads that ask Media add their own.
    r.use(limits.reads('zone.read'));

    /** May this caller act on `project` (read, or `write`)? Throws 404/403 as a ZoneError. */
    async function access(req, project, { write = false, env = null } = {}) {
        const p = req.principal;
        const unknown = () => { throw new ZoneError(404, 'zone.unknown_project', 'no such project'); };
        if (!PROJECT_RE.test(String(project || ''))) unknown();
        if (p.kind === 'app') {
            if (p.project !== project) unknown();
            if (env && p.claims.env === 'sandbox' && env !== 'sandbox') throw new ZoneError(403, 'zone.sandbox_only', 'a sandbox app reaches only the sandbox environment');
            return p.requester;
        }
        if (p.kind === 'user') {
            const role = await clients.memberRole(project, p.requester.slice('user:'.length));
            if (!role) unknown();
            if (write && !ADMIN.has(role)) throw new ZoneError(403, 'zone.not_admin', 'only an admin or owner of the project changes its zones');
            return p.requester;
        }
        throw new ZoneError(401, 'token.required', 'Sign in at openvibe.zone, or send a Network token');
    }

    async function zoneFor(req, { write = false } = {}) {
        if (!ZONE_RE.test(req.params.zone)) throw new ZoneError(404, 'zone.unknown', 'no such zone');
        const row = await zones.byId(req.params.zone);
        if (!row) throw new ZoneError(404, 'zone.unknown', 'no such zone');
        try { await access(req, row.project_id, { write, env: row.env }); } catch (err) {
            // Another project's zone, and a production zone to a sandbox app, do not exist for this caller.
            if (err.code === 'zone.unknown_project' || err.code === 'zone.sandbox_only') throw new ZoneError(404, 'zone.unknown', 'no such zone');
            throw err;
        }
        return row;
    }

    r.get('/ping', (req, res) => res.json({ ok: true, service: 'zone' }));

    r.post('/projects/:project/zones', principal.requireCapability('zone.zone.create'), limits.budget('zone.write'), json, wrap(async (req, res) => {
        const body = req.body || {};
        const caller = await access(req, req.params.project, { write: true, env: body.env });
        const key = req.get('idempotency-key');
        if (key !== undefined && !/^[A-Za-z0-9_.:-]{8,128}$/.test(key)) return send(req, res, 400, 'zone.bad_request', 'Idempotency-Key is 8 to 128 of A-Z a-z 0-9 _ . : -');
        const out = await zones.create(req.params.project, body, { caller, idempotencyKey: key || null });
        res.status(201).json(out.zone);
    }));

    r.get('/projects/:project/zones', principal.requireCapability('zone.zone.list'), wrap(async (req, res) => {
        await access(req, req.params.project, { env: req.query.env || null });
        const q = { ...req.query };
        if (req.principal.kind === 'app' && req.principal.claims.env === 'sandbox') q.env = 'sandbox';
        for (const env of q.env ? [q.env] : ['sandbox', 'production']) if (['sandbox', 'production'].includes(env)) await zones.ensureDefault(req.params.project, env);
        res.json(await zones.list(req.params.project, q));
    }));

    r.get('/zones/:zone', principal.requireCapability('zone.zone.read'), limits.budget('zone.lookup'), wrap(async (req, res) => {
        await zoneFor(req);
        res.json((await zones.get(req.params.zone, { withUsage: true })).zone);
    }));

    r.patch('/zones/:zone', principal.requireCapability('zone.zone.manage'), limits.budget('zone.write'), json, wrap(async (req, res) => {
        await zoneFor(req, { write: true });
        res.json(await zones.update(req.params.zone, req.body || {}));
    }));

    r.delete('/zones/:zone', principal.requireCapability('zone.zone.delete'), limits.budget('zone.write'), wrap(async (req, res) => {
        await zoneFor(req, { write: true });
        const v = contracts.validate('zone.object-zone-delete-query@1', { ...req.query });
        if (!v.valid) return send(req, res, 400, 'zone.bad_request', 'recursive is true or false');
        const recursive = req.query.recursive === 'true';
        res.status(202).json(await zones.remove(req.params.zone, { recursive }));
    }));

    r.get('/zones/:zone/usage', principal.requireCapability('zone.usage.read'), limits.budget('zone.lookup'), wrap(async (req, res) => {
        await zoneFor(req);
        res.json(await zones.usage(req.params.zone));
    }));

    // ── ADR-048: the resource index and control, for OpenVibe.Services (first-party service tokens only) ──
    const firstParty = (cap) => [principal.requireCapability(cap), (req, res, next) => {
        const p = req.principal;
        if (p.kind === 'app' && /^service:/.test(p.requester)) return next();
        return send(req, res, 403, 'capability.denied', `${cap} is first-party`);
    }];
    const summary = (row) => {
        const z = zones.record(row);
        return {
            id: row.id, kind: KIND, service: 'zone', project_id: row.project_id, ovrn: z.ovrn,
            name: `${row.name} (${row.env})`, state: row.state, created_at: z.created_at,
            ...(z.updated_at ? { updated_at: z.updated_at } : {}),
            links: { console: `${config.baseUrl}/p/${row.project_id}#${row.id}`, docs: `${config.baseUrl}/docs` },
        };
    };
    r.get('/resources', ...firstParty('zone.resource.read'), wrap(async (req, res) => {
        const q = req.query;
        const project = typeof q.project === 'string' && q.project ? q.project : null;
        if (project && !PROJECT_RE.test(project)) return send(req, res, 400, 'resources.bad_query', 'project must be a prj_ id');
        if (q.kind && q.kind !== KIND) return res.json({ resources: [], next_cursor: null });
        if (q.owner) return res.json({ resources: [], next_cursor: null });        // zones belong to projects, not people
        const limit = q.limit ? Number(q.limit) : 100;
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return send(req, res, 400, 'resources.bad_query', 'limit must be an integer 1-1000');
        let after = '';
        if (q.cursor) {
            try { after = JSON.parse(Buffer.from(String(q.cursor), 'base64url').toString('utf8'))[1]; } catch { after = null; }
            if (!ZONE_RE.test(String(after || ''))) return send(req, res, 400, 'resources.bad_query', 'cursor is not one this index issued');
        }
        const rows = await ctx.s.db.many(`SELECT * FROM zone_zones WHERE state <> 'deleted' AND ($1::text IS NULL OR project_id = $1) AND id > $2
            ORDER BY id LIMIT $3`, [project, after, limit + 1]);
        const page = rows.slice(0, limit);
        res.json({ resources: page.map(summary), next_cursor: rows.length > limit ? Buffer.from(JSON.stringify([KIND, page[page.length - 1].id])).toString('base64url') : null });
    }));
    r.get('/resources/:ovrn', ...firstParty('zone.resource.read'), wrap(async (req, res) => {
        const parsed = contracts.resources.parse(String(req.params.ovrn || ''));
        const row = parsed && parsed.service === 'zone' && parsed.type === 'object-zone' ? await zones.byId(parsed.id) : null;
        if (!row || row.state === 'deleted' || row.project_id !== parsed.project_id) return send(req, res, 404, 'resources.unknown_resource', `no resource named ${req.params.ovrn}`);
        res.json(summary(row));
    }));

    const canonical = (v) => (Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
        : v && typeof v === 'object' ? `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
            : JSON.stringify(v));
    const digestOf = (request) => crypto.createHash('sha256').update(canonical({ ...request, idempotency_key: undefined, confirmation_id: undefined, trace_id: undefined })).digest('hex');
    const problem = (status, code, detail) => ({ type: `https://openvibe.network/problems/${code}`, title: code, status, code, detail });
    const result = (request, state, extra = {}) => ({ action: request.action, ...(request.resource ? { resource: request.resource } : {}), state, at: new Date(ctx.s.now()).toISOString(), ...extra });

    async function decide(request) {
        const parsed = contracts.resources.parse(request.resource || '');
        if (!parsed || parsed.service !== 'zone' || parsed.type !== 'object-zone' || !ZONE_RE.test(parsed.id)) {
            return result(request, 'refused', { problem: problem(404, 'resources.unknown_resource', `no zone named ${request.resource || request.resource_kind}`) });
        }
        if (request.action !== 'delete') return result(request, 'refused', { problem: problem(422, 'control.unsupported_action', `a zone takes delete, not ${request.action}`) });
        const person = request.on_behalf_of;
        if (!person || person.type !== 'user' || !USER_RE.test(String(person.id || ''))) return result(request, 'refused', { problem: problem(403, 'control.no_person', 'on_behalf_of must name the person acting') });
        const row = await zones.byId(parsed.id);
        const inProject = !!row && row.state !== 'deleted' && row.project_id === parsed.project_id && parsed.project_id === request.project_id;
        let role = null;
        if (inProject) {
            try { role = await clients.memberRole(row.project_id, person.id); } catch {
                return result(request, 'failed', { problem: problem(503, 'identity.unavailable', 'Network could not say whether this person administers the project; nothing was changed') });
            }
        }
        if (!inProject || !ADMIN.has(role)) return result(request, 'refused', { problem: problem(404, 'resources.unknown_resource', `no zone named ${request.resource} that this person may delete`) });
        if (row.is_default) return result(request, 'refused', { problem: problem(409, 'zone.default', 'the default zone goes only with its environment') });
        if (request.dry_run) return result(request, 'done', { result: { dry_run: true, would: 'delete the zone and every object in it, with no restore; its name is never used again' } });
        try {
            const z = await zones.remove(row.id, { recursive: true });
            return result(request, 'done', { result: { status: z.state, changed: true } });
        } catch (err) {
            if (err instanceof ZoneError) return result(request, 'refused', { problem: problem(err.status, err.code, err.detail || err.message) });
            if (err instanceof ClientError) return result(request, 'failed', { problem: problem(503, err.code, err.message) });
            throw err;
        }
    }
    r.post('/resources/control', ...firstParty('zone.resource.control'), json, wrap(async (req, res) => {
        const request = req.body;
        const check = contracts.resources.checkControlRequest(request || {});
        if (!check.valid) return send(req, res, 400, 'control.bad_request', JSON.stringify(check.errors).slice(0, 500));
        const caller = req.principal.requester;
        const digest = digestOf(request);
        const seen = await ctx.s.db.maybe('SELECT digest, response FROM zone_control_log WHERE caller = $1 AND project_id = $2 AND idempotency_key = $3', [caller, request.project_id, request.idempotency_key]);
        if (seen) {
            if (seen.digest !== digest) return send(req, res, 409, 'control.idempotency_conflict', 'this idempotency_key was used for another request');
            return res.json(typeof seen.response === 'string' ? JSON.parse(seen.response) : seen.response);
        }
        const answer = await decide(request);
        await ctx.s.db.exec(`INSERT INTO zone_control_log (caller, project_id, idempotency_key, digest, response, created_at)
            VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`, [caller, request.project_id, request.idempotency_key, digest, JSON.stringify(answer), ctx.s.now()]);
        res.json(answer);
    }));

    return r;
}

module.exports = { createApi };
