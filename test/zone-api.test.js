'use strict';
// OpenVibe.Zone end to end against a mock Network and a fake Media: default zones, creating with an Idempotency-Key,
// names taken and retired, provisioning by revision (provisioning → active), app tokens and the sandbox rule, member
// and admin rules, updates, usage, deletion (not empty, held, recursive, then deleted by the job), the resource index
// and control for Services, and the console pages (zones and keys, the secret once, same-origin forms).
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { boot } = require('./helpers/boot');

const checks = [];
const check = (name, fn) => checks.push([name, fn]);

/** Media as Zone sees it: provisions recorded, reports and keys from a small state. */
function fakeMedia(network) {
    const zones = new Map();       // id → { record, objects, held, completed }
    const pushes = [];
    const keys = [];
    let down = false;
    const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
    const { ClientError } = require('../server/zone/clients');
    return {
        pushes, zones, keys, setDown: (v) => { down = v; },
        async provision(record) {
            if (down) throw new ClientError(503, 'zone.dependency_unavailable', 'media down');
            const check = contracts.zones.checkObjectZone(record);
            if (!check.valid) throw new ClientError(400, 'media.zone.invalid', JSON.stringify(check.errors));
            pushes.push({ id: record.id, state: record.state, revision: record.revision });
            const cur = zones.get(record.id) || { objects: 0, held: 0, completed: false };
            cur.record = record;
            zones.set(record.id, cur);
            return { applied: true };
        },
        async report(id) {
            const z = zones.get(id);
            if (!z) return null;
            return {
                zone_id: id, revision: z.record.revision, state: z.record.state, held_objects: z.held,
                usage: { stored_bytes: z.objects * 100, objects: z.objects, as_of: new Date().toISOString() },
                deletion: z.record.state === 'deleting' ? { requested_at: new Date().toISOString(), objects_remaining: z.completed ? 0 : z.objects, held_objects: 0, completed_at: z.completed ? new Date().toISOString() : null } : null,
            };
        },
        async issueKey(project, body) {
            const key = { id: `ovk_01JZ0000000000000000000K${String(keys.length).padStart(2, '0')}`, project_id: project, env: body.env, name: body.name, permissions: body.permissions, zones: body.zones || [], created_by: body.on_behalf_of, created_at: new Date().toISOString(), last_used_at: null, revoked_at: null };
            keys.push(key);
            return { key, secret: 'S'.repeat(40) };
        },
        async listKeys(project) { return keys.filter((k) => k.project_id === project); },
        async revokeKey(project, id) { const k = keys.find((x) => x.id === id && x.project_id === project); if (!k) throw fail(404, 'media.access_key.unknown', 'no such key'); k.revoked_at = new Date().toISOString(); return k; },
        async memberRole(project, subject) {
            const m = network.state.members.get(project);
            const p = network.state.projects.get(project);
            return m && p && !p.archived_at ? (m.get(subject) || null) : null;
        },
        async projectsOf(token) {
            const res = await fetch(`${network.url}/api/v1/projects`, { headers: { Authorization: `Bearer ${token}` } });
            return (await res.json()).projects;
        },
    };
}

(async () => {
    const { startNetwork } = require('./helpers/mocks');
    const net = await startNetwork();
    let media;
    const EVENTS_SECRET = 'e'.repeat(40); // a test value: 32+ characters
    const t = await boot({ clients: new Proxy({}, { get: (_o, k) => (...a) => media[k](...a) }), env: { ZONE_EVENTS_SECRET: EVENTS_SECRET } });
    await net.close();
    media = fakeMedia(t.network);
    const owner = t.network.addUser('owen');
    const viewer = t.network.addUser('vera');
    const stranger = t.network.addUser('sam');
    const mk = await fetch(`${t.network.url}/api/v1/projects`, { method: 'POST', headers: { Authorization: `Bearer ${t.network.userToken(owner)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Shop' }) });
    const project = (await mk.json()).id;
    t.network.state.members.get(project).set(viewer.subject, 'viewer');
    t.network.setEnvironmentPolicy(project, 'sandbox+production');
    const same = { 'sec-fetch-site': 'same-origin' };

    check('a member lists the project\'s zones; the default zone of each environment exists from then on', async () => {
        const r = await t.get(`/api/v1/projects/${project}/zones`, { as: viewer });
        assert.strictEqual(r.status, 200, r.text);
        const list = r.json();
        assert.ok(contracts.zones.checkObjectZoneList(list).valid, JSON.stringify(contracts.zones.checkObjectZoneList(list).errors));
        assert.deepStrictEqual(list.zones.map((z) => [z.env, z.name, z.state, z.access]).sort(), [['production', 'default', 'active', 'per-object'], ['sandbox', 'default', 'active', 'per-object']]);
        assert.ok(media.pushes.filter((p) => p.state === 'provisioning').length === 2 && media.pushes.filter((p) => p.state === 'active').length === 2, 'Media hears of each zone, then that it is active');
        assert.strictEqual((await t.get(`/api/v1/projects/${project}/zones`, { as: stranger })).status, 404, 'a stranger is told there is no such project');
    });

    let assets;
    check('an admin creates a zone; a repeat with the same Idempotency-Key answers the same zone', async () => {
        const body = { env: 'production', name: 'assets', quota_bytes: 5_000_000 };
        let r = await t.get(`/api/v1/projects/${project}/zones`, { as: owner, json: body, headers: { ...same, 'idempotency-key': 'create-assets-1' } });
        assert.strictEqual(r.status, 201, r.text);
        assets = r.json();
        assert.ok(contracts.zones.checkObjectZone(assets).valid);
        assert.deepStrictEqual([assets.state, assets.access, assets.revision, assets.media_namespace], ['active', 'private', 2, `app.${project}.${assets.id}`]);
        r = await t.get(`/api/v1/projects/${project}/zones`, { as: owner, json: body, headers: { ...same, 'idempotency-key': 'create-assets-1' } });
        assert.deepStrictEqual([r.status, r.json().id], [201, assets.id]);
        r = await t.get(`/api/v1/projects/${project}/zones`, { as: owner, json: { ...body, quota_bytes: 1 }, headers: { ...same, 'idempotency-key': 'create-assets-1' } });
        assert.strictEqual(r.json().code, 'zone.idempotency_conflict');
        r = await t.get(`/api/v1/projects/${project}/zones`, { as: owner, json: { env: 'production', name: 'assets' }, headers: same });
        assert.deepStrictEqual([r.status, r.json().code], [409, 'zone.name_taken']);
        r = await t.get(`/api/v1/projects/${project}/zones`, { as: owner, json: { env: 'production', name: 'metrics' }, headers: same });
        assert.strictEqual(r.json().code, 'zone.name_reserved');
        r = await t.get(`/api/v1/projects/${project}/zones`, { as: owner, json: { env: 'production', name: 'Bad_Name' }, headers: same });
        assert.strictEqual(r.json().code, 'zone.bad_request');
        r = await t.get(`/api/v1/projects/${project}/zones`, { as: viewer, json: { env: 'production', name: 'mine' }, headers: same });
        assert.deepStrictEqual([r.status, r.json().code], [403, 'zone.not_admin'], 'a viewer cannot create');
        r = await t.get(`/api/v1/projects/${project}/zones`, { as: owner, json: { env: 'production', name: 'xsite' }, headers: { 'sec-fetch-site': 'cross-site' } });
        assert.strictEqual(r.json().code, 'request.cross_site', 'a cookie write from another site is refused');
    });

    check('while Media is down a new zone stays provisioning, and the job activates it later', async () => {
        media.setDown(true);
        let r = await t.get(`/api/v1/projects/${project}/zones`, { as: owner, json: { env: 'production', name: 'later' }, headers: same });
        assert.deepStrictEqual([r.status, r.json().state], [201, 'provisioning']);
        const id = r.json().id;
        media.setDown(false);
        await t.ctx.zones.tick();
        r = await t.get(`/api/v1/zones/${id}`, { as: owner });
        assert.strictEqual(r.json().state, 'active');
    });

    check('an app token of the project acts with its capability; a sandbox app only in the sandbox', async () => {
        const res = await fetch(`${t.network.url}/api/v1/projects/${project}/apps`, { method: 'POST', headers: { Authorization: `Bearer ${t.network.userToken(owner)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'deployer', environment: 'sandbox' }) });
        const app = await res.json();
        const tok = t.network.mintApp(app.id, 'openvibe.zone', ['zone.zone.create', 'zone.zone.list', 'zone.zone.read']);
        let r = await t.get(`/api/v1/projects/${project}/zones`, { bearer: tok, json: { env: 'sandbox', name: 'ci-cache' } });
        assert.strictEqual(r.status, 201, r.text);
        r = await t.get(`/api/v1/projects/${project}/zones`, { bearer: tok, json: { env: 'production', name: 'ci-prod' } });
        assert.deepStrictEqual([r.status, r.json().code], [403, 'zone.sandbox_only']);
        r = await t.get(`/api/v1/projects/${project}/zones`, { bearer: tok });
        assert.ok(r.json().zones.every((z) => z.env === 'sandbox'), 'a sandbox app lists the sandbox');
        r = await t.get(`/api/v1/zones/${assets.id}`, { bearer: tok });
        assert.strictEqual(r.status, 404, 'nor reads a production zone');
        const noCap = t.network.mintApp(app.id, 'openvibe.zone', ['zone.zone.list']);
        r = await t.get(`/api/v1/projects/${project}/zones`, { bearer: noCap, json: { env: 'sandbox', name: 'nope' } });
        assert.strictEqual(r.status, 403, 'without zone.zone.create, no create');
    });

    check('update: description and quota; the default zone keeps the environment\'s quota', async () => {
        let r = await t.get(`/api/v1/zones/${assets.id}`, { as: owner, method: 'PATCH', json: { description: 'site files', quota_bytes: 9_000_000 }, headers: same });
        assert.deepStrictEqual([r.status, r.json().description, r.json().quota_bytes, r.json().revision], [200, 'site files', 9_000_000, 3]);
        assert.deepStrictEqual(media.pushes.filter((p) => p.id === assets.id).map((p) => p.revision), [1, 2, 3], 'every revision reached Media');
        const def = (await t.get(`/api/v1/projects/${project}/zones?env=production`, { as: owner })).json().zones.find((z) => z.default);
        r = await t.get(`/api/v1/zones/${def.id}`, { as: owner, method: 'PATCH', json: { quota_bytes: 10 }, headers: same });
        assert.strictEqual(r.json().code, 'zone.default');
        r = await t.get(`/api/v1/zones/${def.id}`, { as: owner, method: 'DELETE', headers: same });
        assert.strictEqual(r.json().code, 'zone.default', 'and cannot be deleted on its own');
    });

    check('usage is Media\'s snapshot, in zone.object-zone-usage@1', async () => {
        media.zones.get(assets.id).objects = 3;
        const r = await t.get(`/api/v1/zones/${assets.id}/usage`, { as: viewer });
        assert.strictEqual(r.status, 200);
        assert.ok(contracts.zones.checkObjectZoneUsage(r.json()).valid, JSON.stringify(contracts.zones.checkObjectZoneUsage(r.json()).errors));
        assert.deepStrictEqual([r.json().current.objects, r.json().current.stored_bytes], [3, 300]);
        const z = (await t.get(`/api/v1/zones/${assets.id}`, { as: viewer })).json();
        assert.deepStrictEqual(z.usage.objects, 3);
    });

    check('Media\'s hourly rollups (media.usage.recorded) arrive signed and sum into the usage series and the console', async () => {
        const { signDeliveryHeaders } = require('openvibe-sdk/events');
        const { ids } = contracts;
        const HOUR = 3600 * 1000;
        const hour = Math.floor(Date.now() / HOUR) * HOUR - HOUR;
        const ovrn = `ovrn:zone:${project}:object-zone/${assets.id}`;
        const def = (await t.get(`/api/v1/projects/${project}/zones?env=${assets.env}`, { as: owner })).json().zones.find((z) => z.default);
        const rollup = (payload, over = {}) => ({
            event_id: ids.newId('event'), event_type: 'media.usage.recorded', version: 1, source: 'media', actor: { type: 'service', id: 'media' },
            timestamp: new Date().toISOString(), subject: { type: 'project', id: project }, visibility: 'internal', priority: 'low',
            payload: { project_id: project, env: assets.env, resource: ovrn, dimension: assets.id.toLowerCase(), window: 'hour',
                window_start: new Date(hour).toISOString(), window_end: new Date(hour + HOUR).toISOString(), errors: 0, ...payload }, ...over,
        });
        const deliver = async (ev, { secret = EVENTS_SECRET, headers = {} } = {}) => {
            const raw = JSON.stringify({ event: ev });
            const res = await fetch(`${t.base}/internal/events`, { method: 'POST', headers: { 'content-type': 'application/json', ...signDeliveryHeaders(raw, secret), ...headers }, body: raw });
            return { status: res.status, body: await res.json() };
        };
        let r = await deliver(rollup({ capability: 'media.object.read', unit: 'requests', quantity: 10 }));
        assert.deepStrictEqual([r.status, r.body.outcome], [200, 'recorded'], JSON.stringify(r.body));
        assert.strictEqual((await deliver(rollup({ capability: 'media.object.read', unit: 'egress_bytes', quantity: 2048 }))).body.outcome, 'recorded');
        assert.strictEqual((await deliver(rollup({ capability: 'media.object.read', unit: 'requests', quantity: 12, revision: 2 }))).body.outcome, 'recorded', 'a corrected hour replaces it');
        assert.strictEqual((await deliver(rollup({ capability: 'media.object.read', unit: 'requests', quantity: 1, revision: 1 }))).body.outcome, 'ignored:stale', 'an older revision never does');
        assert.strictEqual((await deliver(rollup({ capability: 'media.object.read', unit: 'requests', quantity: 1 }, { source: 'tools' }))).body.outcome, 'ignored:source', 'only Media reports');
        assert.strictEqual((await deliver(rollup({ capability: 'media.object.read', unit: 'requests', quantity: 1, dimension: def.id.toLowerCase() }))).body.outcome, 'ignored:resource', 'resource and dimension name one zone');
        const elsewhere = `zon_${ids.ulid()}`;
        assert.strictEqual((await deliver(rollup({ capability: 'media.object.read', unit: 'requests', quantity: 1, resource: `ovrn:zone:${project}:object-zone/${elsewhere}`, dimension: elsewhere.toLowerCase() }))).body.outcome, 'ignored:zone', 'a zone Zone does not have');
        assert.strictEqual((await deliver(rollup({ capability: 'media.object.read', unit: 'requests', quantity: 1, env: assets.env === 'production' ? 'sandbox' : 'production' }))).body.outcome, 'ignored:zone', 'or of another environment');
        assert.strictEqual((await deliver(rollup({ capability: 'media.object.read', unit: 'requests', quantity: 1 }), { secret: 'x'.repeat(40) })).status, 401, 'unsigned deliveries are refused');
        assert.strictEqual((await deliver(rollup({ capability: 'media.object.read', unit: 'requests', quantity: 1 }), { headers: { 'x-forwarded-for': '203.0.113.9' } })).status, 403, 'and so is anything through a proxy');
        r = await t.get(`/api/v1/zones/${assets.id}/usage`, { as: viewer });
        const u = r.json();
        assert.ok(contracts.zones.checkObjectZoneUsage(u).valid, JSON.stringify(contracts.zones.checkObjectZoneUsage(u).errors));
        const q = (unit) => (u.series.find((x) => x.capability === 'media.object.read' && x.unit === unit) || {}).quantity;
        assert.deepStrictEqual([q('requests'), q('egress_bytes')], [12, 2048], 'the series sums the month\'s hours');
        assert.strictEqual(u.window_end, new Date(hour + HOUR).toISOString(), 'up to the last hour Media reported');
        r = await t.get(`/p/${project}`, { as: owner });
        assert.ok(r.text.includes('this month: 12 requests · 2.0 KB out'), 'the console shows the month\'s requests and egress');
    });

    check('deletion: not empty, held, then recursive; the job marks it deleted and its name is retired', async () => {
        let r = await t.get(`/api/v1/zones/${assets.id}`, { as: owner, method: 'DELETE', headers: same });
        assert.deepStrictEqual([r.status, r.json().code], [409, 'zone.not_empty']);
        media.zones.get(assets.id).held = 1;
        r = await t.get(`/api/v1/zones/${assets.id}?recursive=true`, { as: owner, method: 'DELETE', headers: same });
        assert.deepStrictEqual([r.status, r.json().code], [409, 'zone.held']);
        media.zones.get(assets.id).held = 0;
        r = await t.get(`/api/v1/zones/${assets.id}?recursive=true`, { as: owner, method: 'DELETE', headers: same });
        assert.deepStrictEqual([r.status, r.json().state], [202, 'deleting']);
        assert.ok(contracts.zones.checkObjectZone(r.json()).valid);
        assert.strictEqual(media.zones.get(assets.id).record.state, 'deleting', 'Media hears of it at once');
        await t.ctx.zones.tick();
        assert.strictEqual((await t.get(`/api/v1/zones/${assets.id}`, { as: owner })).json().state, 'deleting', 'deleted only once Media reports nothing left');
        media.zones.get(assets.id).completed = true;
        await t.ctx.zones.tick();
        r = await t.get(`/api/v1/zones/${assets.id}`, { as: owner });
        assert.deepStrictEqual([r.json().state, r.json().deletion.objects_remaining, !!r.json().deletion.completed_at], ['deleted', 0, true]);
        assert.ok(contracts.zones.checkObjectZone(r.json()).valid);
        assert.strictEqual(media.zones.get(assets.id).record.state, 'deleted');
        r = await t.get(`/api/v1/projects/${project}/zones`, { as: owner, json: { env: 'production', name: 'assets' }, headers: same });
        assert.deepStrictEqual([r.status, r.json().code], [409, 'zone.name_retired'], 'a deleted zone\'s name is never given again');
        r = await t.get(`/api/v1/projects/${project}/zones?env=production`, { as: owner });
        assert.ok(!r.json().zones.some((z) => z.id === assets.id), 'deleted zones leave the list');
        r = await t.get(`/api/v1/projects/${project}/zones?env=production&include_deleted=true`, { as: owner });
        assert.ok(r.json().zones.some((z) => z.id === assets.id), 'unless asked for');
    });

    check('Services: the resource index and a delete through the control API, for an admin only, once', async () => {
        const svc = t.network.serviceToken('services', ['zone.resource.read', 'zone.resource.control']);
        let r = await t.get(`/api/v1/resources?project=${project}`, { bearer: svc });
        assert.strictEqual(r.status, 200, r.text);
        const later = r.json().resources.find((x) => x.name === 'later (production)');
        assert.ok(later && later.ovrn === `ovrn:zone:${project}:object-zone/${later.id}` && later.kind === 'zone.object-zone');
        r = await t.get(`/api/v1/resources/${encodeURIComponent(later.ovrn)}`, { bearer: svc });
        assert.strictEqual(r.json().id, later.id);
        const req = (who, key) => ({ project_id: project, resource: later.ovrn, action: 'delete', on_behalf_of: { type: 'user', id: who.subject }, idempotency_key: key });
        r = await t.get('/api/v1/resources/control', { bearer: svc, json: req(viewer, 'ctl-viewer-0001') });
        assert.deepStrictEqual([r.json().state, r.json().problem.code], ['refused', 'resources.unknown_resource'], 'a viewer cannot delete');
        r = await t.get('/api/v1/resources/control', { bearer: svc, json: req(owner, 'ctl-owner-00001') });
        assert.deepStrictEqual([r.json().state, r.json().result.status], ['done', 'deleting'], r.text);
        const again = await t.get('/api/v1/resources/control', { bearer: svc, json: req(owner, 'ctl-owner-00001') });
        assert.deepStrictEqual(again.json(), r.json(), 'a repeat returns the stored answer');
        r = await t.get(`/api/v1/resources?project=${project}`, { bearer: t.network.serviceToken('services', ['zone.zone.read']) });
        assert.strictEqual(r.status, 403, 'the index needs zone.resource.read');
    });

    check('the console: projects, zones, a key whose secret is shown once, and same-origin forms', async () => {
        let r = await t.get('/projects', { as: owner });
        assert.ok(r.status === 200 && r.text.includes('Shop') && r.text.includes(`/p/${project}`), r.text.slice(0, 400));
        r = await t.get(`/p/${project}`, { as: owner });
        assert.ok(r.status === 200 && r.text.includes('Production') && r.text.includes('Sandbox') && r.text.includes('Issue key'));
        r = await t.get(`/p/${project}/zones`, { as: owner, form: { env: 'production', name: 'photos', quota_mb: '5' }, headers: { origin: 'https://openvibe.zone' } });
        assert.ok(r.status === 200 && r.text.includes('Zone photos is ready in production'), r.text.slice(0, 500));
        r = await t.get(`/p/${project}/keys`, { as: owner, form: { env: 'production', name: 'backups', permissions: 'write' }, headers: same });
        assert.ok(r.text.includes('S'.repeat(40)) && r.text.includes('shown only once'), 'the secret is on the page that issued it');
        r = await t.get(`/p/${project}`, { as: owner });
        assert.ok(!r.text.includes('S'.repeat(40)) && r.text.includes('backups'), 'and on no other page');
        r = await t.get(`/p/${project}/keys/${media.keys[0].id}/revoke`, { as: owner, method: 'POST', form: {}, headers: same });
        assert.ok(r.text.includes('is revoked'));
        r = await t.get(`/p/${project}/zones`, { as: owner, form: { env: 'production', name: 'evil' }, headers: { 'sec-fetch-site': 'cross-site' } });
        assert.strictEqual(r.status, 403, 'a form from another site is refused');
        r = await t.get(`/p/${project}`, { as: viewer });
        assert.ok(r.text.includes('Only an admin or owner') && !r.text.includes('Issue key'), 'a viewer sees the zones, not the forms');
        r = await t.get(`/p/${project}`, { as: stranger });
        assert.strictEqual(r.status, 404);
        r = await t.get(`/p/${project}`);
        assert.strictEqual(r.status, 401);
        r = await t.get('/');
        assert.ok(r.status === 200 && r.text.includes('s3.openvibe.media') && r.text.includes('Private storage zones'));
        assert.ok(!/<pre(?![^>]*tabindex)[\s>]/.test(r.text), 'every <pre> is focusable (axe scrollable-region-focusable)');
        r = await t.get('/docs');
        assert.ok(r.status === 200 && r.text.includes('zone.zone.create'));
        // The S3 list matches Media's surface: copies are supported (Media#113); ACLs, policies and versioning are not.
        assert.ok(r.text.includes('<strong>Server-side copies:</strong> CopyObject and UploadPartCopy'), 'copies are listed as supported');
        assert.ok(!r.text.includes('Not yet supported'), 'no stale not-yet list');
    });

    let failed = 0;
    try {
        for (const [name, fn] of checks) {
            try { await fn(); console.log(`  ✓ ${name}`); } catch (err) { failed++; console.log(`  ✗ ${name}\n${err.stack}`); }
        }
    } finally {
        await t.close();
    }
    if (failed) { console.log(`${failed} failed`); process.exit(1); }
    console.log('\nall passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
