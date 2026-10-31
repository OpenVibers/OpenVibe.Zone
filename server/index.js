'use strict';

/**
 * OpenVibe.Zone — process entry. `node server/index.js`
 * Listens on PORT (5050) behind nginx (deploy/).
 */
const { createApp } = require('./app');
const { gracefulStop } = require('openvibe-sdk/service');
const { startTelemetryRetention } = require('openvibe-sdk/telemetry');
const { startSubscriptions, TOPICS: ACCOUNT_TOPICS } = require('openvibe-sdk/account-data');

/**
 * The process stop (openvibe-sdk/service): the HTTP drain runs, then the timers clear, the zone job stops, the JWKS
 * refresher stops and the store closes. Exported so a test can inject `exit` and `signals: false`. `extra` is what
 * start() adds (the job).
 */
function createLifecycle({ server, ctx, exit, signals, timers = [], extra = [] }) {
    return gracefulStop({
        name: 'OpenVibe.Zone', server, deadlineExitCode: 0, exit, signals, deadlineMs: 10_000,
        close: [() => { for (const t of timers) clearInterval(t); }, ...extra, () => ctx.keys.client.stop(), async () => { clearInterval(ctx.telemetryTick); if (ctx.retention) await ctx.retention.stop(); if (ctx.telemetry) await ctx.telemetry.stop(); }, () => ctx.s.close()],
    });
}

async function start() {
    const { app, ctx } = await createApp();
    const { config } = ctx;

    // Socket activation (2026-10-31): systemd's .socket unit holds the listener across restarts, so a deploy
    // queues requests in the kernel instead of answering 502. Without the socket unit, the usual listen.
    const socketActivated = process.env.LISTEN_FDS === '1' && Number(process.env.LISTEN_PID) === process.pid;
    const server = app.listen(...(socketActivated ? [{ fd: 3 }] : [config.port, config.host]), () => {
        console.log(`[OpenVibe.Zone] ${config.nodeEnv} on http://${config.host}:${config.port} → ${config.baseUrl} (db ${ctx.s.db.store})`);
    });
    server.keepAliveTimeout = 65_000;
    // telemetry_samples rows older than 14 days go: a minute after start, then daily (openvibe-sdk/telemetry).
    ctx.retention = startTelemetryRetention({ db: ctx.s.db, log: ctx.log || console, olderThanDays: 14 });
    // The request collector aggregates in memory and has no timer of its own (openvibe-sdk 0.46 createHttpTelemetry):
    // this tick writes each minute's samples; the stop clears it and flushes once more.
    ctx.telemetryTick = setInterval(() => { ctx.telemetry.flush().catch(() => {}); }, 60_000);
    ctx.telemetryTick.unref();
    ctx.keys.client.start();
    // The zone job (zone/zones.js tick): pushes what Media has not acknowledged and finishes deletions, every 15 s.
    ctx.zones.start();
    // Media's per-zone rollups (media.usage.recorded) at OpenVibe.Events, created when missing, and the two account
    // topics (ADR-033) for a person's export and deletion; off without EVENTS_URL, ZONE_EVENTS_SECRET or the client
    // secret.
    const subscriptions = startSubscriptions({
        eventsUrl: config.events.url, endpoint: `http://127.0.0.1:${config.port}/internal/events`, secret: config.events.secrets[0],
        topics: [ctx.usage.TOPIC, ...ACCOUNT_TOPICS],
        networkInternalUrl: config.networkInternalUrl, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
    });
    createLifecycle({ server, ctx, extra: [() => ctx.zones.stop(), () => { if (subscriptions) subscriptions.stop(); }] });
    return { server, ctx };
}

if (require.main === module) {
    start().catch((err) => { console.error('[OpenVibe.Zone] failed to start:', err); process.exit(1); });
}

module.exports = { start, createLifecycle };
