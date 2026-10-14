'use strict';
/**
 * Sign-in with PKCE S256 (client id zone, cookies zone_at/zone_rt/zone_oauth), truthful readiness
 * (the database is required; JWKS, the OAuth client and Valkey are optional), /release.json, loopback-only
 * /metrics, and pages useful without JavaScript.
 */
const assert = require('assert');
const crypto = require('crypto');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const user = t.network.addUser('kim');

    await check('login redirects to Network with state and an S256 code challenge', async () => {
        const r = await t.get('/auth/login?next=/updates');
        assert.strictEqual(r.status, 302);
        const loc = new URL(r.headers.get('location'));
        assert.strictEqual(loc.origin + loc.pathname, `${t.network.url}/oauth/authorize`);
        assert.strictEqual(loc.searchParams.get('client_id'), 'zone');
        assert.strictEqual(loc.searchParams.get('code_challenge_method'), 'S256');
        assert.match(loc.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
        assert.match(loc.searchParams.get('state'), /^[0-9a-f]{32}$/);
        assert.match(r.headers.get('set-cookie'), /zone_oauth=.*Path=\/auth.*HttpOnly/i);
    });

    await check('callback exchanges the code with the matching verifier and sets httpOnly session cookies', async () => {
        const login = await t.get('/auth/login?next=/updates');
        const loc = new URL(login.headers.get('location'));
        const flowCookie = login.headers.get('set-cookie').split(';')[0];
        const code = t.network.issueCode(user, loc.searchParams.get('code_challenge'));
        const r = await t.get(`/auth/callback?code=${code}&state=${loc.searchParams.get('state')}`, { cookie: flowCookie });
        assert.strictEqual(r.status, 302, r.text);
        assert.strictEqual(r.headers.get('location'), '/updates');
        const set = r.headers.get('set-cookie');
        assert.match(set, /zone_at=[^;]+;.*HttpOnly/i);
        assert.match(set, /zone_rt=[^;]+;.*HttpOnly/i);
        const at = set.match(/zone_at=([^;]+)/)[1];
        const me = await t.get('/auth/me', { cookie: `zone_at=${at}` });
        assert.strictEqual(me.json().user.username, 'kim');
        assert.ok(!me.text.includes(at), '/auth/me never returns the token');
    });

    await check('a wrong state or a verifier that does not match is refused', async () => {
        const login = await t.get('/auth/login');
        const loc = new URL(login.headers.get('location'));
        const flowCookie = login.headers.get('set-cookie').split(';')[0];
        const code = t.network.issueCode(user, loc.searchParams.get('code_challenge'));
        const bad = await t.get(`/auth/callback?code=${code}&state=${'0'.repeat(32)}`, { cookie: flowCookie });
        assert.strictEqual(bad.status, 400);
        const other = t.network.issueCode(user, crypto.createHash('sha256').update('another-verifier').digest('base64url'));
        const mismatch = await t.get(`/auth/callback?code=${other}&state=${loc.searchParams.get('state')}`, { cookie: flowCookie });
        assert.strictEqual(mismatch.status, 400, 'Network refuses the PKCE check; the service reports it');
        const noCookie = await t.get(`/auth/callback?code=${code}&state=${loc.searchParams.get('state')}`);
        assert.strictEqual(noCookie.status, 400);
    });

    await check('next= only accepts same-site paths', async () => {
        const r = await t.get('/auth/login?next=//evil.example/x');
        const flow = decodeURIComponent(r.headers.get('set-cookie').match(/zone_oauth=([^;]+)/)[1]);
        assert.strictEqual(JSON.parse(flow).next, '/');
    });

    await check('readiness is truthful: db required; JWKS, the OAuth client and Valkey optional', async () => {
        const r = await t.get('/api/ready');
        const b = r.json();
        assert.strictEqual(r.status, 200);
        assert.strictEqual(b.checks.db.status, 'ok');
        assert.strictEqual(b.checks.db.required, true);
        assert.strictEqual(b.checks.network_jwks.status, 'ok');
        assert.strictEqual(b.checks.network_jwks.required, false);
        assert.strictEqual(b.checks.oauth_client.status, 'ok');
        assert.strictEqual(b.checks.oauth_client.required, false);
        assert.ok('valkey' in b.checks, 'the optional Valkey check is listed');
    });

    await check('/release.json and /metrics (loopback only)', async () => {
        const rel = await t.get('/release.json');
        assert.strictEqual(rel.status, 200);
        assert.strictEqual(rel.json().service, 'zone');
        assert.deepStrictEqual(require('openvibe-contracts').validate('registry.release-manifest@1', rel.json()).errors, []);
        assert.strictEqual(rel.json().metrics_url, '/release-metrics');
        const m = await t.get('/metrics');
        assert.strictEqual(m.status, 200);
        assert.match(m.text, /http_requests_total|release_info/);
        const proxied = await t.get('/metrics', { headers: { 'x-forwarded-for': '203.0.113.9' } });
        assert.notStrictEqual(proxied.status, 200, 'a proxied request is not loopback');
    });

    await check('public pages are complete without JavaScript (noscript nav, SSR footer)', async () => {
        for (const p of ['/', '/updates']) {
            const r = await t.get(p);
            assert.strictEqual(r.status, 200, p);
            assert.match(r.text, /<noscript><nav/);
            assert.match(r.text, /<footer id="ov-footer"/);
            assert.match(r.text, /<main id="main"/);
        }
    });

    await check('the API answers /ping and unknown routes are problem+json 404', async () => {
        const ping = await t.get('/api/v1/ping');
        assert.strictEqual(ping.status, 200);
        assert.deepStrictEqual(ping.json(), { ok: true, service: 'zone' });
        const gone = await t.get('/api/v1/nope');
        assert.strictEqual(gone.status, 404);
        assert.match(gone.headers.get('content-type'), /application\/problem\+json/);
        assert.strictEqual(gone.json().code, 'route.not_found');
    });

    await t.close();
    done();
})();
