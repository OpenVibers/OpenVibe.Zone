'use strict';

/**
 * Truthful readiness for GET /api/ready (openvibe-shared/ready, Track O).
 *
 *   db              required  a real round trip to OpenVibe.Zone's PostgreSQL store
 *   network_jwks    optional  the Network signing key is loaded; without it nobody can sign in or call the API
 *   oauth_client    optional  OV_OAUTH_CLIENT_SECRET is set (sign-in needs it)
 *   valkey          optional  shared per-caller limit counters
 *
 * The product adds its own required checks here (a queue, a model provider, a worker) with a real round trip,
 * so /api/ready never reads green for something that is not working.
 */
const { jwksStatus } = require('openvibe-sdk/auth');
const { createReadiness } = require('openvibe-shared/ready');

function createServiceReadiness({ s, config, valkey = null, release = null, sso = null }) {
    return createReadiness({
        service: 'zone',
        release,
        checks: [
            {
                name: 'db', required: true,
                check: async () => {
                    const r = await s.db.ready();
                    return r.ok ? { ok: true, detail: r.detail } : r.error;
                },
            },
            { name: 'valkey', required: false, check: async () => (valkey ? valkey.ready() : { skipped: 'VALKEY_URL not set: per-caller limits count in this process only' }) },
            {
                name: 'network_jwks', required: false,
                check: () => {
                    const statuses = jwksStatus();
                    if (!statuses.length) return 'no JWKS clients (misconfigured)';
                    const first = statuses[0];
                    if (!first.ready) return 'Network signing key not loaded yet: sign-in and the API are unavailable';
                    return { ok: true, detail: { keys: first.keys, failures: first.failures, stale: first.stale, fetched_at: first.fetchedAt } };
                },
            },
            { name: 'oauth_client', required: false, check: () => (config.oauth.clientSecret ? true : 'OV_OAUTH_CLIENT_SECRET unset: sign-in cannot complete') },
            {
                // Does the Network accept this site's OAuth client? 'invalid' means the id or the secret is wrong:
                // the service must not stay ready on a sign-in that cannot work. 'unknown' (the Network did not
                // answer) is left alone — that is the Network's outage, not this site's configuration.
                name: 'sso_client', required: true,
                check: async () => {
                    if (!sso || typeof sso.checkClient !== 'function') return { skipped: 'no SSO client' };
                    const client = await sso.checkClient();
                    if (client === 'invalid') return 'the Network refuses this site\'s OAuth client: check OV_OAUTH_CLIENT_ID / OV_OAUTH_CLIENT_SECRET';
                    return true;
                },
            },
        ],
    });
}

module.exports = { createServiceReadiness };
