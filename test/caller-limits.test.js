'use strict';
/**
 * Per-caller rate limits (server/http/caller-limits.js): past its limit one caller gets 429 problem+json
 * `rate_limited` with Retry-After, before the route does any work, while another caller still passes; the
 * window reopens on the clock. A person counts as themselves, anyone else by address. Reads take
 * ZONE_LIMITS_MINUTE/ZONE_LIMITS_HOUR; the product's expensive routes get their own numbers in BUDGETS.
 * Health, ready, release.json and metrics are never limited; refusals are logged (no token) and counted in
 * zone_rate_limited_total.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { caller, BUDGETS } = require('../server/http/caller-limits');

const READ = 'zone.read';

(async () => {
    // The limiter's clock: 15 s into a minute, so the minute window has 45 s left. Reads: 3 a minute.
    let clock = Date.UTC(2026, 8, 27, 12, 0, 15);
    const t = await boot({ callerLimits: true, limitsNow: () => clock, env: { ZONE_LIMITS_MINUTE: '3', ZONE_LIMITS_HOUR: '100' } });
    const rosa = t.network.addUser('rosa');
    const sam = t.network.addUser('sam');

    await check('the product\'s writes have their own numbers: defining a title, posting results', () => {
        assert.deepStrictEqual(Object.keys(BUDGETS).sort(), ['zone.lookup', 'zone.write']);
        Object.values(BUDGETS).forEach((b) => assert.ok(b.minute > 0 && b.hour >= b.minute, JSON.stringify(b)));
    });

    await check('a read: 3 a minute per address, then 429 rate_limited with Retry-After; another address passes', async () => {
        const from = (ip) => ({ headers: { 'x-forwarded-for': ip } });
        for (let i = 0; i < 3; i++) assert.strictEqual((await t.get('/api/v1/ping', from('203.0.113.7'))).status, 200);
        const r = await t.get('/api/v1/ping', from('203.0.113.7'));
        assert.strictEqual(r.status, 429);
        assert.match(r.headers.get('content-type'), /application\/problem\+json/);
        assert.ok(Number(r.headers.get('retry-after')) > 0 && Number(r.headers.get('retry-after')) <= 45, r.headers.get('retry-after'));
        const body = r.json();
        assert.strictEqual(body.code, 'rate_limited');
        assert.ok(body.detail.includes(READ), body.detail);
        assert.strictEqual((await t.get('/api/v1/ping', from('203.0.113.8'))).status, 200, 'another address still passes');
    });

    await check('a signed-in person counts as themselves, not by address', async () => {
        for (let i = 0; i < 3; i++) assert.strictEqual((await t.get('/api/v1/ping', { as: rosa, headers: { 'x-forwarded-for': '203.0.113.7' } })).status, 200, 'rosa is not the address that was refused');
        const r = await t.get('/api/v1/ping', { as: rosa, headers: { 'x-forwarded-for': '203.0.113.9' } });
        assert.strictEqual(r.status, 429, 'rosa is over her own limit from any address');
        assert.strictEqual((await t.get('/api/v1/ping', { as: sam, headers: { 'x-forwarded-for': '203.0.113.9' } })).status, 200, 'another person still passes');
    });

    await check('the next minute opens the window again', async () => {
        clock += 60_000;
        assert.strictEqual((await t.get('/api/v1/ping', { as: rosa })).status, 200);
    });

    await check('a budget that was never declared cannot be taken', () => {
        assert.throws(() => t.ctx.limits.budget('zone.thing.create'), /no budget named/);
    });

    await check('health, ready, release.json and metrics are never limited', async () => {
        for (let i = 0; i < 6; i++) {
            assert.strictEqual((await t.get('/api/health')).status, 200);
            assert.notStrictEqual((await t.get('/api/ready')).status, 429);
            assert.strictEqual((await t.get('/release.json')).status, 200);
            assert.strictEqual((await t.get('/metrics')).status, 200);
        }
    });

    await check('refusals are counted in zone_rate_limited_total and logged without a token', async () => {
        const m = (await t.get('/metrics')).text;
        const counted = m.split('\n').filter((l) => l.includes('zone_rate_limited_total')).join('\n');
        assert.ok(/zone_rate_limited_total\{limit="zone\.read",window="minute"\} 2/.test(m), counted);
        const logs = t.logs();
        assert.ok(logs.includes(`[Limits] ${READ}: user:${rosa.subject} refused`), 'one log line per refusal');
        assert.ok(logs.includes(`[Limits] ${READ}: ip:203.0.113.7 refused`), 'the address refusal is logged');
        assert.ok(!/\[Limits\][^\n]*eyJ/.test(logs), 'a token in the log');
    });

    await check('who is counted', () => {
        assert.strictEqual(caller({ principal: { requester: 'app:app_x' }, viewer: { kind: 'user', subject: 'usr_a' }, ip: '203.0.113.1' }), 'app:app_x', 'a principal wins');
        assert.strictEqual(caller({ viewer: { kind: 'user', subject: 'usr_a' }, ip: '203.0.113.1' }), 'user:usr_a');
        assert.strictEqual(caller({ viewer: { kind: 'anonymous' }, ip: '198.51.100.4' }), 'ip:198.51.100.4');
    });

    await t.close();
    done();
})();
