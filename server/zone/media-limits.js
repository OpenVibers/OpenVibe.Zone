'use strict';

/**
 * The storage limits a zone meets, as OpenVibe.Media (the service that enforces them) publishes them at /limits.json:
 * bytes per project environment, upload and part sizes, how long a deleted object can be restored. The home shows
 * them instead of numbers typed into Zone. Read on loopback at most every ten minutes; a slow or failing Media never
 * slows the page (2 s timeout) and the last good list, or none, is used: the sections that need it then hide.
 */
const TTL_MS = 10 * 60_000;
const TIMEOUT_MS = 2_000;

function createMediaLimits({ config, fetchImpl = globalThis.fetch, now = () => Date.now(), log = console } = {}) {
    let cache = { at: 0, byId: null };
    let inflight = null;

    async function refresh() {
        try {
            const res = await fetchImpl(`${config.media.internalUrl}/limits.json`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
            if (!res.ok) throw new Error(`Media answered ${res.status}`);
            const body = await res.json();
            const list = Array.isArray(body && body.limits) ? body.limits : [];
            cache = { at: now(), byId: new Map(list.filter((l) => l && typeof l.id === 'string' && Number.isFinite(Number(l.production))).map((l) => [l.id, l])) };
        } catch (err) {
            cache = { at: now(), byId: cache.byId };   // keep the last good list; try again after the TTL
            log.warn && log.warn(`[Zone] media limits: ${err.message}`);
        }
        return cache.byId || new Map();
    }

    return {
        /** Map of limit id → { id, label, unit, production, sandbox }; empty when Media has not answered yet. */
        async get() {
            if (cache.byId && now() - cache.at < TTL_MS) return cache.byId;
            inflight = inflight || refresh().finally(() => { inflight = null; });
            return await inflight;
        },
    };
}

module.exports = { createMediaLimits, TTL_MS };
