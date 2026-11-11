'use strict';
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    let t;
    const media = {
        async provision() { return { applied: true }; },
        async report() { return null; },
        async memberRole(project, subject) {
            const members = t.network.state.members.get(project);
            const p = t.network.state.projects.get(project);
            return members && p && !p.archived_at ? members.get(subject) || null : null;
        },
        async listKeys() { return []; },
        async projectsOf(token) {
            const res = await fetch(`${t.network.url}/api/v1/projects`, { headers: { Authorization: `Bearer ${token}` } });
            return (await res.json()).projects;
        },
    };
    t = await boot({ clients: media });
    const owner = t.network.addUser('owner');
    const other = t.network.addUser('other');
    const stranger = t.network.addUser('stranger');
    const made = await fetch(`${t.network.url}/api/v1/projects`, {
        method: 'POST', headers: { Authorization: `Bearer ${t.network.userToken(owner)}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Sharing defaults' }),
    });
    const project = (await made.json()).id;
    t.network.state.members.get(project).set(other.subject, 'admin');
    t.network.setEnvironmentPolicy(project, 'sandbox+production');
    const same = { 'sec-fetch-site': 'same-origin' };
    const share = async (id) => await t.ctx.s.db.maybe('SELECT * FROM shares WHERE service = $1 AND kind = $2 AND resource_id = $3', ['zone', 'zone', id]);
    const create = async (as, name) => {
        const r = await t.get(`/api/v1/projects/${project}/zones`, { as, json: { env: 'production', name }, headers: same });
        assert.strictEqual(r.status, 201, r.text);
        return r.json();
    };

    await check('preference is private, personal, and a session write requires same origin', async () => {
        const get = await t.get('/api/v1/share-defaults/zone', { as: owner });
        assert.strictEqual(get.status, 200, get.text);
        assert.strictEqual(get.json().audience, 'private');
        assert.strictEqual((await t.get('/api/v1/share-defaults/zone', { as: stranger })).json().audience, 'private');
        assert.strictEqual((await t.get('/api/v1/share-defaults/zone')).status, 401);
        const cross = await t.get('/api/v1/share-defaults/zone', { as: owner, method: 'PUT', json: { audience: 'people' } });
        assert.strictEqual(cross.status, 403);
        const bad = await t.get('/api/v1/share-defaults/zone', { as: owner, method: 'PUT', json: { audience: 'public' }, headers: same });
        assert.strictEqual(bad.status, 400);
    });

    let own, teammate;
    await check('new named buckets use the maker preference; project defaults stay private', async () => {
        const set = await t.get('/api/v1/share-defaults/zone', { as: owner, method: 'PUT', json: { audience: 'people' }, headers: same });
        assert.strictEqual(set.status, 200, set.text);
        own = await create(owner, 'mine');
        teammate = await create(other, 'theirs');
        assert.strictEqual((await share(own.id)).audience, 'people');
        assert.strictEqual((await share(teammate.id)).audience, 'private');
        assert.strictEqual((await t.get(`/api/v1/zones/${own.id}`, { as: stranger })).status, 404,
            'Specific people without recipients does not open the bucket');
        const defaultBucket = await t.ctx.s.db.maybe("SELECT * FROM zone_zones WHERE project_id = $1 AND name = 'default'", [project]);
        assert.strictEqual(await share(defaultBucket.id), null);
    });

    await check('per-bucket override and apply to all touch only the maker-owned named buckets', async () => {
        const override = await t.get(`/api/v1/zone/${own.id}/share`, {
            as: owner, method: 'PUT', json: { audience: 'private' }, headers: { ...same, 'x-requested-with': 'ov-share' },
        });
        assert.strictEqual(override.status, 200, override.text);
        assert.strictEqual((await share(own.id)).audience, 'private');
        const own2 = await create(owner, 'mine-two');
        const set = await t.get('/api/v1/share-defaults/zone', {
            as: owner, method: 'PUT', json: { audience: 'private', apply_to_all: true }, headers: same,
        });
        assert.strictEqual(set.status, 200, set.text);
        assert.strictEqual(set.json().applied, 2);
        assert.strictEqual((await share(own2.id)).audience, 'private');
        assert.strictEqual((await share(teammate.id)).audience, 'private');
        const row = await t.ctx.s.db.maybe('SELECT audience FROM zone_share_defaults WHERE subject = $1', [owner.subject]);
        assert.strictEqual(row.audience, 'private');
    });

    await check('project page exposes and saves the personal choice', async () => {
        const page = await t.get(`/p/${project}`, { as: owner });
        assert.strictEqual(page.status, 200, page.text.slice(0, 200));
        assert(page.text.includes('Apply to all my existing named buckets'));
        const post = await t.get(`/p/${project}/share-default`, {
            as: owner, method: 'POST', form: { audience: 'people', apply_to_all: '1' }, headers: same,
        });
        assert.strictEqual(post.status, 200, post.text.slice(0, 300));
        assert(post.text.includes('Updated 2 existing named buckets'));
        assert.strictEqual((await share(own.id)).audience, 'people');
        assert.strictEqual((await share(teammate.id)).audience, 'private');
    });

    await t.close();
    done();
})().catch((err) => { console.error(err); process.exit(1); });
