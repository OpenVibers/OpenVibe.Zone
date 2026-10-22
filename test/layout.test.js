'use strict';
/**
 * Every page carries the openvibe-shared boost marker and self-starting script (plan T11), so a
 * same-site click swaps <main> in place without a reload. The marker names the layout's release,
 * which the app sets from openvibe-shared/release (a swap only happens between pages of the same
 * release; across a deploy it is a normal load), the boost tag names #main in data-main, and the
 * shared navbar's sign-in follows the current page through the {path} template.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const MARKER = /<meta name="ov-boost" content="(zone@[0-9A-Za-z._+-]{1,64})">/;
const BOOST = /<script src="\/shared\/boost\.js\?v=[0-9a-f]{12}" data-main="#main" defer><\/script>/;

(async () => {
    const t = await boot();
    const user = t.network.addUser('kim');
    const release = (await t.get('/release.json')).json().release;

    await check('every rendered page carries the ov-boost marker (the app\'s release) and the data-main boost script', async () => {
        for (const p of ['/', '/updates']) {
            const r = await t.get(p);
            assert.strictEqual(r.status, 200, p);
            const m = r.text.match(MARKER);
            assert.ok(m, `${p}: no ov-boost marker`);
            assert.strictEqual(m[1], `zone@${release}`, `${p}: the marker is not the app's release`);
            assert.match(r.text, BOOST, `${p}: no boost script with data-main`);
            assert.match(r.text, /<main id="main"/, `${p}: the page's main is not #main`);
        }
        const signedIn = await t.get('/updates', { as: user });
        assert.strictEqual(signedIn.status, 200);
        assert.match(signedIn.text, MARKER, '/updates signed in: no ov-boost marker');
        assert.match(signedIn.text, BOOST, '/updates signed in: no boost script');
    });

    await check('the home page head comes from openvibe-shared/shell with the same title, canonical, robots and JSON-LD', async () => {
        const r = await t.get('/');
        // The home's meta description is a sentence for search results (50-160 characters), not "Name — tagline".
        { const d = (/<meta name="description" content="([^"]*)"/.exec(r.text) || [])[1] || ''; assert.ok(d.length >= 50 && d.length <= 160 && !d.includes(' — '), `home description: ${d}`); }
        assert.strictEqual(r.status, 200);
        const head = r.text.slice(0, r.text.indexOf('</head>'));
        assert.strictEqual((r.text.match(/<title>/g) || []).length, 1, 'exactly one <title>');
        assert.ok(head.includes('<title>OpenVibe.Zone: Private S3-compatible storage</title>'), 'home title');
        assert.ok(head.includes('<link rel="canonical" href="https://openvibe.zone/">'), 'canonical');
        assert.ok(head.includes('<meta name="robots" content="index, follow">'), 'robots');
        const ld = [...head.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1])['@type']);
        assert.deepStrictEqual(ld, ['WebSite', 'WebPage', 'FAQPage'], 'the home JSON-LD: the site, the page and the questions it shows');
        for (const tag of ['<meta property="og:title"', 'data-ov-icon="zone"', '/css/app.css?v=', '/shared/theme-loader.js', '/shared/navbar.js', '/shared/footer.js', '<meta name="referrer"']) {
            assert.ok(head.includes(tag), `head has ${tag}`);
        }
        assert.ok(r.text.includes('id="ov-footer"'), 'the server-rendered footer');
        assert.ok(r.text.includes('OpenVibeFooter.init(window.__OV_PAGE.footer)'), 'the footer is initialised');
    });

    await check('the navbar config uses the {path} login template, not the path baked in', async () => {
        const r = await t.get('/updates');
        assert.match(r.text, /"loginUrl":"\/auth\/login\?next=\{path\}"/);
        assert.ok(!/"loginUrl":"\/auth\/login\?next=%2F/.test(r.text), 'loginUrl still has the current path baked in');
    });

    await check('the home page shows the service name and the tagline server-side, with no local path', async () => {
        const r = await t.get('/');
        assert.strictEqual(r.status, 200, r.text.slice(0, 300));
        assert.match(r.headers.get('content-type'), /^text\/html/);
        assert.ok(r.text.includes('OpenVibe.Zone'), 'the service name is on the page');
        assert.ok(r.text.includes('Private storage zones'), 'what it is, on the page');
        const h1 = (/<h1[^>]*>([\s\S]*?)<\/h1>/.exec(r.text) || [])[1] || '';
        assert.strictEqual(h1.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(), 'Private storage zones: S3 buckets for your projects.', 'the heading reads as one sentence');
        assert.ok(r.text.includes('/shared/showcase.css'), 'the showcase stylesheet');
        assert.ok(!r.text.includes('/home/') && !r.text.includes('/mnt/'), 'no local filesystem path on the page');
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
