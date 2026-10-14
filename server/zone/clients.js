'use strict';

/**
 * Zone's calls to the two services it depends on, each with Zone's own client-credentials token (never a person's,
 * except where a person's own projects are listed):
 *
 * OpenVibe.Media (audience openvibe.media):
 *   provision(record)                 PUT  /internal/zones/:id     media.zone.provision → { applied, state, usage, deletion }
 *   report(zoneId)                    GET  /internal/zones/:id     → { state, usage, deletion } (null when Media has none)
 *   issueKey(project, body)           POST /api/v1/projects/:p/access-keys            media.access_key.manage → { key, secret }
 *   listKeys(project, person)         GET  /api/v1/projects/:p/access-keys?on_behalf_of=
 *   revokeKey(project, keyId, person) DELETE …/access-keys/:id?on_behalf_of=
 *
 * OpenVibe.Network:
 *   memberRole(project, subject)      GET  /internal/projects/:p/members/:s  network.project.member.read → role | null
 *   projectsOf(personToken)           GET  /api/v1/projects with the person's own token → their projects
 *
 * A failure is a ClientError with the status and problem code the other service answered (or 503 when it did not).
 */
const { serviceAuth } = require('openvibe-contracts');

const TIMEOUT_MS = 10_000;

class ClientError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function createClients({ config, fetchImpl = globalThis.fetch }) {
    const tokenUrl = `${config.networkInternalUrl}/oauth/token`;
    const secret = config.oauth.clientSecret;
    const mediaTokens = secret ? serviceAuth.createTokenClient({
        tokenUrl, clientId: config.oauth.clientId, clientSecret: secret, audience: 'openvibe.media',
        scope: 'media.zone.provision media.access_key.manage', fetchImpl,
    }) : null;
    const networkTokens = secret ? serviceAuth.createTokenClient({
        tokenUrl, clientId: config.oauth.clientId, clientSecret: secret, audience: 'openvibe.network',
        scope: 'network.project.member.read', fetchImpl,
    }) : null;

    async function call(tokens, base, method, path, body) {
        if (!tokens) throw new ClientError(503, 'zone.unconfigured', 'OV_OAUTH_CLIENT_SECRET is not set: Zone cannot call its services');
        let res;
        try {
            res = await fetchImpl(`${base}${path}`, {
                method,
                headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(await tokens.authHeaders()) },
                body: body ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
        } catch (err) {
            throw new ClientError(503, 'zone.dependency_unavailable', `${base} did not answer: ${err.message}`);
        }
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new ClientError(res.status, (data && data.code) || `http_${res.status}`, (data && (data.detail || data.error)) || `answered ${res.status}`);
        return data;
    }
    const media = (method, path, body) => call(mediaTokens, config.media.internalUrl, method, path, body);
    const q = (person) => `on_behalf_of=${encodeURIComponent(person)}`;

    return {
        provision: (record) => media('PUT', `/internal/zones/${record.id}`, record),
        async report(zoneId) {
            try { return await media('GET', `/internal/zones/${zoneId}`); } catch (err) {
                if (err.status === 404) return null;
                throw err;
            }
        },
        issueKey: (project, body) => media('POST', `/api/v1/projects/${project}/access-keys`, body),
        listKeys: async (project, person) => (await media('GET', `/api/v1/projects/${project}/access-keys?${q(person)}`)).keys,
        revokeKey: (project, keyId, person) => media('DELETE', `/api/v1/projects/${project}/access-keys/${encodeURIComponent(keyId)}?${q(person)}`),

        async memberRole(project, subject) {
            try {
                const m = await call(networkTokens, config.networkInternalUrl, 'GET', `/internal/projects/${project}/members/${subject}`);
                return m && m.project_id === project && m.subject === subject && m.archived === false ? m.role : null;
            } catch (err) {
                if (err.status === 404) return null;
                throw err;
            }
        },
        async projectsOf(personToken) {
            let res;
            try {
                res = await fetchImpl(`${config.networkInternalUrl}/api/v1/projects`, { headers: { Accept: 'application/json', Authorization: `Bearer ${personToken}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
            } catch (err) { throw new ClientError(503, 'zone.dependency_unavailable', `Network did not answer: ${err.message}`); }
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new ClientError(res.status, (data && data.code) || `http_${res.status}`, (data && data.detail) || `answered ${res.status}`);
            return (data && data.projects) || [];
        },
    };
}

module.exports = { createClients, ClientError };
