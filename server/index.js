'use strict';

/**
 * OpenVibe.Zone — process entry. `node server/index.js`
 * Listens on PORT (5050) behind nginx (deploy/).
 */
const { createApp } = require('./app');
const { gracefulStop } = require('openvibe-sdk/service');
const { startSubscriptions } = require('openvibe-sdk/account-data');

/**
 * The process stop (openvibe-sdk/service): the HTTP drain runs, then the timers clear, the zone job stops, the JWKS
 * refresher stops and the store closes. Exported so a test can inject `exit` and `signals: false`. `extra` is what
 * start() adds (the job).
 */
function createLifecycle({ server, ctx, exit, signals, timers = [], extra = [] }) {
    return gracefulStop({
        name: 'OpenVibe.Zone', server, deadlineExitCode: 0, exit, signals, deadlineMs: 10_000,
        close: [() => { for (const t of timers) clearInterval(t); }, ...extra, () => ctx.keys.client.stop(), () => ctx.s.close()],
    });
}

async function start() {
    const { app, ctx } = await createApp();
    const { config } = ctx;

    const server = app.listen(config.port, config.host, () => {
        console.log(`[OpenVibe.Zone] ${config.nodeEnv} on http://${config.host}:${config.port} → ${config.baseUrl} (db ${ctx.s.db.store})`);
    });
    server.keepAliveTimeout = 65_000;
    ctx.keys.client.start();
    // The zone job (zone/zones.js tick): pushes what Media has not acknowledged and finishes deletions, every 15 s.
    ctx.zones.start();
    // Media's per-zone rollups (media.usage.recorded) at OpenVibe.Events, created when missing; off without EVENTS_URL,
    // ZONE_EVENTS_SECRET or the client secret.
    const subscriptions = startSubscriptions({
        eventsUrl: config.events.url, endpoint: `http://127.0.0.1:${config.port}/internal/events`, secret: config.events.secrets[0],
        topics: [ctx.usage.TOPIC],
        networkInternalUrl: config.networkInternalUrl, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
    });
    createLifecycle({ server, ctx, extra: [() => ctx.zones.stop(), () => { if (subscriptions) subscriptions.stop(); }] });
    return { server, ctx };
}

if (require.main === module) {
    start().catch((err) => { console.error('[OpenVibe.Zone] failed to start:', err); process.exit(1); });
}

module.exports = { start, createLifecycle };
