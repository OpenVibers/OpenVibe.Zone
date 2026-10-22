'use strict';
/**
 * The home and the guide show OpenVibe.Media's published limits, never numbers typed into Zone: the figures beside the
 * hero, the limits table, the size rule ("one request carries at most …") and the cost answer all come from Media's
 * /limits.json (zone/media-limits.js). Without Media's answer those figures hide and the words stay true. The FAQ shown
 * on the page is the FAQPage data. media-limits reads at most every ten minutes and keeps the last good list.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { createMediaLimits, TTL_MS } = require('../server/zone/media-limits');

const MB = 1024 ** 2;
const LIMITS = [
    { id: 'storage_bytes', label: 'Stored bytes (every namespace of the tenant)', unit: 'bytes', production: 1024 * MB, sandbox: 100 * MB },
    { id: 'single_upload_bytes', label: 'Size of a single-part upload', unit: 'bytes', production: 256 * MB, sandbox: 256 * MB },
    { id: 'multipart_bytes', label: 'Size of a multipart upload', unit: 'bytes', production: 20 * 1024 * MB, sandbox: 2 * 1024 * MB },
    { id: 'part_bytes', label: 'Size of one multipart part', unit: 'bytes', production: 256 * MB, sandbox: 256 * MB },
    { id: 'deleted_retention_days', label: 'Days a deleted object can be restored', unit: 'days', production: 30, sandbox: 30 },
];

(async () => {
    const withLimits = await boot({ mediaLimits: { get: async () => new Map(LIMITS.map((l) => [l.id, l])) } });
    await check('with Media\'s limits: the figures, the table, the size rule and the questions', async () => {
        const r = await withLimits.get('/');
        assert.strictEqual(r.status, 200);
        assert.match(r.text, /<dl class="zn-stats">/);
        assert.match(r.text, /<dt>1\.0 GB<\/dt><dd>per project in production, at no charge<\/dd>/);
        assert.match(r.text, /<dt>100 MB<\/dt><dd>more in each project&#39;s sandbox<\/dd>|<dt>100 MB<\/dt><dd>more in each project's sandbox<\/dd>/);
        assert.match(r.text, /<dt>30 days<\/dt><dd>to restore a deleted object<\/dd>/);
        assert.match(r.text, /one request carries at most 256 MB/, 'the size rule is Media\'s, not the old 100 MB');
        assert.ok(!/at most 100 MB/.test(r.text));
        assert.match(r.text, /sc-limits/, 'the limits table');
        assert.match(r.text, /href="https:\/\/openvibe\.media\/limits\.json"/, 'and where it is read from');
        const ld = [...r.text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1])).find((j) => j['@type'] === 'FAQPage');
        const shown = [...r.text.matchAll(/<summary>([^<]*)<\/summary>/g)].map((m) => m[1].replace(/&#39;/g, "'"));
        assert.deepStrictEqual(ld.mainEntity.map((q) => q.name), shown, 'the FAQPage data asks what the page asks');
        assert.match(ld.mainEntity.find((q) => q.name === 'What does it cost?').acceptedAnswer.text, /1\.0 GB in production and 100 MB in its sandbox/);
        const docs = await withLimits.get('/docs');
        assert.match(docs.text, /one request carries at most 256 MB/, 'the guide says the same');
    });
    await withLimits.close();

    const without = await boot();
    await check('without Media\'s answer: the figures and the table hide, and the words stay true', async () => {
        const r = await without.get('/');
        assert.strictEqual(r.status, 200);
        assert.ok(!r.text.includes('zn-stats') && !r.text.includes('sc-limits'));
        assert.match(r.text, /larger files go up in parts/);
        assert.match(r.text, /Each project includes storage in production and in its sandbox at no charge\./);
    });
    await without.close();

    await check('media-limits: read once per ten minutes, the last good list kept when Media fails', async () => {
        let t = 0, calls = 0, fail = false;
        const fetchImpl = async () => {
            calls++;
            if (fail) throw new Error('refused');
            return { ok: true, json: async () => ({ limits: [...LIMITS, { id: 'broken' }] }) };
        };
        const ml = createMediaLimits({ config: { media: { internalUrl: 'http://media.test' } }, fetchImpl, now: () => t, log: {} });
        const first = await ml.get();
        assert.strictEqual(first.get('storage_bytes').production, 1024 * MB);
        assert.ok(!first.has('broken'), 'an entry without a number is dropped');
        await ml.get();
        assert.strictEqual(calls, 1, 'cached');
        t += TTL_MS + 1; fail = true;
        assert.strictEqual((await ml.get()).get('part_bytes').production, 256 * MB, 'Media down: the last good list');
        const empty = createMediaLimits({ config: { media: { internalUrl: 'http://media.test' } }, fetchImpl: async () => { throw new Error('refused'); }, log: {} });
        assert.strictEqual((await empty.get()).size, 0, 'never answered: nothing');
    });
    done();
})().catch((err) => { console.error(err); process.exit(1); });
