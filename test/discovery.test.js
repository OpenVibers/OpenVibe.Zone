'use strict';
// Crawl artifacts (server/http/discovery.js): robots.txt keeps crawlers off sign-in, the API and people's projects; the
// sitemap lists the public pages only; llms.txt says what a zone is and where the S3 endpoint is; llms-full.txt lists
// every public page.
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    try {
        await check('robots.txt keeps crawlers off sign-in, the API and projects, and names the sitemap', async () => {
            const r = await t.get('/robots.txt');
            assert.strictEqual(r.status, 200);
            for (const p of ['/auth/', '/api/', '/projects', '/p/']) assert.ok(r.text.includes(`Disallow: ${p}`), p);
            assert.match(r.text, /Sitemap: https:\/\/openvibe\.zone\/sitemap\.xml/);
        });

        await check('the sitemap lists the public pages and nothing of anyone\'s project', async () => {
            const r = await t.get('/sitemap.xml');
            assert.match(r.headers.get('content-type'), /xml/);
            for (const loc of ['/', '/docs', '/updates']) assert.ok(r.text.includes(`<loc>https://openvibe.zone${loc}</loc>`), loc);
            assert.doesNotMatch(r.text, /\/p\/|\/projects/);
        });

        await check('llms.txt says what a zone is and names the S3 endpoint', async () => {
            const r = await t.get('/llms.txt');
            assert.match(r.text, /^# OpenVibe\.Zone/m);
            assert.match(r.text, /https:\/\/s3\.openvibe\.media/);
            assert.match(r.text, /Using OpenVibe\.Zone/);
        });

        await check('llms-full.txt lists every public page', async () => {
            const r = await t.get('/llms-full.txt');
            for (const s of ['OpenVibe.Zone home', 'Using OpenVibe.Zone', 'What shipped on OpenVibe.Zone']) assert.ok(r.text.includes(s), s);
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
