'use strict';
/**
 * ADR-033: Zone's part of an account export and deletion, through the signed POST /internal/events route with the
 * stand-in Network. Ada's telemetry goes in her export (her own samples only), her deletion takes the subject off
 * them, and Bo's samples stay theirs. The guard fails when a new table with a person column is neither covered nor
 * exempted with a reason.
 */
const assert = require('assert');
const { uncovered } = require('openvibe-sdk/account-data');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { boot, check, done } = require('./helpers/boot');
const { TABLES } = require('../server/account-data');

const SECRET = `whsec_${'fixture'.repeat(6)}`;
const A = 'usr_01JZ0000000000000000000AAA';
const B = 'usr_01JZ0000000000000000000BBB';
const EXP = 'exp_01JZ0000000000000000000EXP';
const DEL = 'del_01JZ0000000000000000000DEX';

const ev = (id, type, payload) => ({ event_id: id, event_type: type, source: 'network', version: 1, timestamp: new Date().toISOString(), payload });

(async () => {
    const t = await boot({ env: { ZONE_EVENTS_SECRET: SECRET } });
    const db = t.ctx.s.db;
    try {
        await check('every table that names a person is covered or exempted with a reason', async () => {
            const missing = await uncovered(db, { tables: TABLES, exempt: { account_data_events: 'the ledger of requests itself: which export and deletion Zone applied' } });
            assert.deepStrictEqual(missing, [], `a table with a person column is neither covered nor exempted: ${missing.join(', ')}`);
        });

        await check('an export carries the person\'s telemetry samples, and nobody else\'s', async () => {
            for (const [subject, name] of [[A, 'ada'], [B, 'bo']]) {
                await db.exec("INSERT INTO telemetry_samples (at, service, operation, resource, status, latency_ms, subject) VALUES (now(), 'zone', 'http.request', '/zones', '2xx', 12, $1)", [subject]);
            }
            const body = JSON.stringify({ event: ev('evt_01JZ0000000000000000000E01', 'network.account.export_requested', { export_id: EXP, subject: A }), seq: 1 });
            const res = await t.get('/internal/events', { method: 'POST', body, headers: { 'content-type': 'application/json', ...signDeliveryHeaders(body, SECRET) } });
            assert.strictEqual(res.status, 200, res.text);
            assert.strictEqual(res.json().outcome, 'exported');
            const parts = t.network.state.accountParts;
            const part = parts.find((p) => p.id === EXP);
            assert.ok(part, 'the part was posted to Network');
            const samples = part.body.files.find((f) => f.name === 'telemetry.json');
            assert.ok(samples, 'telemetry.json is in the part');
            assert.strictEqual(samples.content.length, 1, JSON.stringify(samples.content));
            assert.strictEqual(samples.content[0].resource, '/zones');
            assert.ok(!JSON.stringify(part.body).includes(B), 'nobody else\'s rows');
        });

        await check('a deletion takes the subject off their samples and confirms once', async () => {
            const body = JSON.stringify({ event: ev('evt_01JZ0000000000000000000D01', 'network.account.deleted', { deletion_id: DEL, subject: A, aliases: [] }), seq: 1 });
            const res = await t.get('/internal/events', { method: 'POST', body, headers: { 'content-type': 'application/json', ...signDeliveryHeaders(body, SECRET) } });
            assert.strictEqual(res.status, 200, res.text);
            assert.strictEqual(res.json().outcome, 'erased');
            assert.strictEqual(await db.value('SELECT subject FROM telemetry_samples WHERE subject = $1', [A]), null, 'her samples keep no subject');
            assert.strictEqual(await db.value('SELECT subject FROM telemetry_samples WHERE subject = $1', [B]), B, 'Bo stays');
            const confirmations = t.network.state.accountConfirmations;
            const confirmation = confirmations.find((c) => c.id === DEL);
            assert.ok(confirmation, 'the confirmation was sent');
        });

        await check('an unsigned delivery is refused', async () => {
            const body = JSON.stringify({ event: ev('evt_01JZ0000000000000000000E02', 'network.account.export_requested', { export_id: EXP, subject: A }), seq: 1 });
            const res = await t.get('/internal/events', { method: 'POST', body, headers: { 'content-type': 'application/json' } });
            assert.strictEqual(res.status, 401, res.text);
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
