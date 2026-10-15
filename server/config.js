'use strict';

/**
 * OpenVibe.Zone configuration. Every value comes from the environment (production: /etc/openvibe/zone.env, see
 * .env.example). Only environment variable NAMES appear in code and docs; secrets are never logged.
 *
 * load(env) is pure so tests can build a config without touching process.env.
 */
require('dotenv').config();
const trim = (s) => String(s || '').replace(/\/+$/, '');
const int = (v, def) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : def);

function load(env = process.env) {
    const nodeEnv = env.NODE_ENV || 'development';
    const isProduction = nodeEnv === 'production';
    const port = int(env.PORT, 5050);
    const baseUrl = trim(env.BASE_URL || (isProduction ? 'https://openvibe.zone' : `http://localhost:${port}`));
    const networkUrl = trim(env.OV_NETWORK_URL || 'https://openvibe.network');

    return {
        service: 'zone',
        port,
        host: env.HOST || '127.0.0.1',
        nodeEnv,
        isProduction,
        baseUrl,
        trustProxy: env.TRUST_PROXY != null ? Number(env.TRUST_PROXY) : 2,
        // Per-caller limits (server/http/caller-limits.js): the requests one caller (an app, a person, else an
        // address) may make per minute and per hour. The product's own routes add tighter budgets there.
        limits: {
            minute: Math.max(1, int(env.ZONE_LIMITS_MINUTE, 120)),
            hour: Math.max(1, int(env.ZONE_LIMITS_HOUR, 3000)),
        },

        // PostgreSQL (ADR-035): DATABASE_URL serves (PgBouncer), DATABASE_DIRECT_URL migrates (owner role). In
        // development without DATABASE_URL an embedded PGlite database in data/pglite is used (ZONE_PGLITE_DIR
        // overrides the directory).
        db: { url: env.DATABASE_URL || '', directUrl: env.DATABASE_DIRECT_URL || '', pgliteDir: env.ZONE_PGLITE_DIR || '' },
        valkey: { url: env.VALKEY_URL || '', prefix: env.VALKEY_PREFIX || 'ov:zone:' },

        // OpenVibe.Network: SSO (OAuth2 authorization server with PKCE) and its JWKS.
        networkUrl,
        networkInternalUrl: trim(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000'),
        networkIssuer: trim(env.OV_NETWORK_ISSUER || networkUrl),
        // The audience this service's app, agent and service tokens carry.
        // Network's rule for every grant: the audience is openvibe.<service> (not the site's host name).
        audience: env.ZONE_AUDIENCE || 'openvibe.zone',
        oauth: {
            clientId: env.OV_OAUTH_CLIENT_ID || 'zone',
            clientSecret: env.OV_OAUTH_CLIENT_SECRET || '',
            redirectUri: env.OV_OAUTH_REDIRECT_URI || `${baseUrl}/auth/callback`,
            scope: 'profile',
            sessionAudience: env.OV_SESSION_AUDIENCE || 'openvibe.network',
        },
        cookies: { secure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProduction },

        // OpenVibe.Media: Zone provisions each zone there and asks it for usage and deletion progress (loopback, with
        // Zone's own service token); the S3 endpoint is what the docs and the console tell people to use.
        media: {
            internalUrl: trim(env.MEDIA_INTERNAL_URL || 'http://127.0.0.1:4100'),
            s3Endpoint: trim(env.ZONE_S3_ENDPOINT || 'https://s3.openvibe.media'),
        },
        // OpenVibe.Events: ZONE_EVENTS_SECRET signs the deliveries to POST /internal/events (Media's per-zone rollups,
        // media.usage.recorded; comma-separated for rotation, 32+ characters each). Unset, the route answers 503 and no
        // subscription is created at boot.
        events: {
            url: trim(env.EVENTS_URL || ''),
            secrets: String(env.ZONE_EVENTS_SECRET || '').split(',').map((x) => x.trim()).filter(Boolean),
        },
        // The zones one project environment may hold besides its default.
        maxZonesPerEnv: Math.max(1, int(env.ZONE_MAX_PER_ENV, 20)),
    };
}

module.exports = { load };
