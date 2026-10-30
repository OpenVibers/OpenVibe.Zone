'use strict';
/**
 * POST /internal/events: OpenVibe.Events delivers Zone's subscriptions here (media.usage.recorded, and the two
 * account topics — network.account.export_requested and network.account.deleted — for ADR-033). No body parser
 * runs before it: the v2 signature covers the raw body. Loopback only: a request that came through a proxy is
 * refused. 2xx once applied (or ignored with a reason); anything else makes Events retry.
 */
const { parseDelivery } = require('openvibe-sdk/events');
const { TOPICS: ACCOUNT_TOPICS } = require('openvibe-sdk/account-data');

const LIMIT = 256 * 1024;

function eventsIntake({ secrets = [], usage, accountData = null, accountSend = null, log = console, now = () => Date.now() }) {
    const keys = (secrets || []).filter((x) => typeof x === 'string' && x.length >= 32);
    const reply = (res, status, body) => {
        res.status(status).set('Cache-Control', 'no-store').type(status < 300 ? 'application/json' : 'application/problem+json').send(JSON.stringify(body));
    };
    const problem = (res, status, code, detail) => reply(res, status, { type: 'about:blank', title: code, status, code, detail });
    const readRaw = (req) => new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => { size += c.length; if (size > LIMIT) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
    return async function handle(req, res) {
        if (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers['cf-connecting-ip']) return problem(res, 403, 'zone.internal_only', 'internal route');
        if (!keys.length) return problem(res, 503, 'zone.events_disabled', 'no events secret is configured');
        let raw;
        try { raw = await readRaw(req); } catch (err) { return problem(res, err.status || 400, 'bad_request', 'unreadable body'); }
        let delivery = null;
        for (const k of keys) { delivery = parseDelivery(raw, req.headers, k, { requireV2: true, now: now() }); if (delivery) break; }
        if (!delivery || !delivery.event || typeof delivery.event.event_type !== 'string') return problem(res, 401, 'zone.bad_signature', 'X-OpenVibe-Signature-V2 does not verify or is outside the replay window');
        const ev = delivery.event;
        // The account export and deletion (ADR-033, server/account-data.js): Zone's part of a person's export, and
        // the erasure of what it keeps. The two account topics are answered here, next to Media's usage rollups.
        if (ACCOUNT_TOPICS.includes(ev.event_type)) {
            if (!accountData) return problem(res, 503, 'zone.account_disabled', 'no account-data module is configured');
            try {
                const outcome = await accountData.apply(ev, { send: accountSend });
                return reply(res, 200, { event_id: ev.event_id, outcome });
            } catch (err) {
                log.warn(`[account-data] event ${ev.event_id} (${ev.event_type}) failed: ${(err && err.message) || err}`);
                return problem(res, 503, 'zone.retry', 'not applied; Events will retry');
            }
        }
        try {
            const outcome = ev.event_type === usage.TOPIC ? await usage.apply(ev) : 'ignored:type';
            return reply(res, 200, { event_id: ev.event_id, outcome });
        } catch (err) {
            log.warn(`[Events] ${ev.event_type} ${ev.event_id} failed: ${(err && err.message) || err}`);
            return problem(res, 503, 'zone.retry', 'not applied; Events will retry');
        }
    };
}

module.exports = { eventsIntake };
