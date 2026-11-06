'use strict';
/**
 * Sharing on Zone buckets (design 2026-11-06, VISIBILITY-EVERYWHERE step 4; openvibe-sdk/share).
 * A bucket is private storage: its objects are the project's, reached with its S3 keys. The Share
 * sheet names a teammate who may read its console record; it is never Everyone or a public link.
 */
const assert = require('assert');
const { boot } = require('./helpers/boot');

let failures = 0;
async function check(name, fn) {
    try { await fn(); process.stdout.write(`  ✓ ${name}\n`); } catch (e) { failures++; process.stdout.write(`  ✗ ${name}\n      ${(e.stack || String(e)).split('\n').slice(0, 5).join('\n      ')}\n`); }
}

(async () => {
    const media = {
        async provision() { return { applied: true }; },
        async report() { return null; },
        async memberRole(project, subject) {
            const m = t.network.state.members.get(project);
            const p = t.network.state.projects.get(project);
            return m && p && !p.archived_at ? (m.get(subject) || null) : null;
        },
        async listKeys() { return []; },
    };
    const t = await boot({ clients: media });
    const owner = t.network.addUser('owen');
    const mate = t.network.addUser('mia');
    const stranger = t.network.addUser('sam');
    const mk = await fetch(`${t.network.url}/api/v1/projects`, { method: 'POST', headers: { Authorization: `Bearer ${t.network.userToken(owner)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Shop' }) });
    const project = (await mk.json()).id;
    t.network.state.members.get(project).set(mate.subject, 'viewer');
    t.network.setEnvironmentPolicy(project, 'sandbox+production');
    const same = { 'sec-fetch-site': 'same-origin' };

    await check('a new bucket is registered Only me, owned by the person who made it', async () => {
        const r = await t.get(`/api/v1/projects/${project}/zones`, { as: owner, json: { env: 'production', name: 'assets' }, headers: same });
        assert.strictEqual(r.status, 201, r.text);
        const zone = r.json();
        const s = await t.ctx.s.db.maybe('SELECT * FROM shares WHERE service = $1 AND kind = $2 AND resource_id = $3', ['zone', 'zone', zone.id]);
        assert.strictEqual(s.audience, 'private');
        assert.deepStrictEqual(s.owner_subject, { type: 'user', id: owner.subject });
        assert.strictEqual((await t.get(`/api/v1/zones/${zone.id}`, { as: owner })).status, 200);
        assert.strictEqual((await t.get(`/api/v1/zones/${zone.id}`, { as: stranger })).status, 404, 'a stranger is not a project member');
    });

    await check('Specific people: the named person reads the bucket record; the project stays closed to them', async () => {
        const list = await t.get(`/api/v1/projects/${project}/zones`, { as: owner });
        const zone = list.json().zones.find((z) => z.name === 'assets');
        const put = await t.get(`/api/v1/zone/${zone.id}/share`, { as: owner, method: 'PUT', json: { audience: 'people', members: [{ subject: { type: 'user', id: stranger.subject }, role: 'viewer' }] }, headers: { 'x-requested-with': 'ov-share' } });
        assert.strictEqual(put.status, 200, put.text);
        assert.strictEqual(put.json().audience, 'people');
        assert.strictEqual((await t.get(`/api/v1/zones/${zone.id}`, { as: stranger })).status, 200, 'the record, never its keys or objects');
        assert.strictEqual((await t.get(`/api/v1/projects/${project}/zones`, { as: stranger })).status, 404, 'the project is still not theirs');
        assert.strictEqual((await t.get(`/api/v1/zones/${zone.id}`, { as: mate })).status, 200, 'the project member already could');
        assert.strictEqual((await t.get(`/api/v1/zone/${zone.id}/share`, { as: stranger })).status, 404, 'the sheet is the owner’s');
    });

    await check('the sheet offers only Specific people and Only me; a bucket is never Everyone or a link', async () => {
        const list = await t.get(`/api/v1/projects/${project}/zones`, { as: owner });
        const zone = list.json().zones.find((z) => z.name === 'assets');
        const sheet = await t.get(`/api/v1/zone/${zone.id}/share`, { as: owner });
        assert.strictEqual(sheet.status, 200);
        assert.deepStrictEqual(sheet.json().audiences, ['people', 'private']);
        const pub = await t.get(`/api/v1/zone/${zone.id}/share`, { as: owner, method: 'PUT', json: { audience: 'public' }, headers: { 'x-requested-with': 'ov-share' } });
        assert.strictEqual(pub.status, 400, 'a bucket cannot be made public');
    });

    process.stdout.write(failures ? `\n${failures} failed\n` : '\nall passed\n');
    await t.close();
    process.exit(failures ? 1 : 0);
})();
