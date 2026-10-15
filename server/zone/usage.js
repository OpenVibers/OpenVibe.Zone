'use strict';
/**
 * A zone's metered usage (ADR-031 section 8): the hourly rollups Media sends as media.usage.recorded
 * (common.usage-recorded@1), kept per zone, hour and series. Zone never counts: it stores what Media reports and sums
 * it for GET /zones/:zone/usage and the console. Media is the only source; a rollup names its zone twice (resource is
 * the zone's OVRN, dimension its id in lowercase) and both must name a zone of its project here.
 *
 *   apply(event)                 'recorded' or an 'ignored:*' outcome (a newer or equal revision replaces the hour)
 *   series(zoneId, { from })     [{ capability, unit, quantity }] summed from `from` (ms), and the last reported hour's end
 *   prune()                      hours older than KEEP_DAYS
 */
const contracts = require('openvibe-contracts');

const TOPIC = 'media.usage.recorded';
const HOUR_MS = 3600 * 1000;
const KEEP_DAYS = 400;
const OVRN = /^ovrn:zone:(prj_[0-9A-HJKMNP-TV-Z]{26}):object-zone\/(zon_[0-9A-HJKMNP-TV-Z]{26})$/;

function createUsage({ s, log = console }) {
    const { db } = s;

    async function apply(event) {
        if (!event || event.event_type !== TOPIC) return 'ignored:type';
        if (event.source !== 'media') return 'ignored:source';
        const p = event.payload && typeof event.payload === 'object' ? event.payload : {};
        const v = contracts.validate(`${TOPIC}@${event.version || 1}`, p);
        if (!v.valid) {
            log.warn(`[Usage] ${event.event_id} does not match ${TOPIC}: ${v.errors.slice(0, 3).map((e) => `${e.path} ${e.message}`).join('; ')}`);
            return 'ignored:payload';
        }
        const subject = event.subject || {};
        if (subject.type !== 'project' || subject.id !== p.project_id) return 'ignored:subject';
        const m = OVRN.exec(String(p.resource || ''));
        if (!m || m[1] !== p.project_id || String(p.dimension || '') !== m[2].toLowerCase()) return 'ignored:resource';
        const zone = await db.maybe('SELECT id, project_id, env FROM zone_zones WHERE id = $1', [m[2]]);
        if (!zone || zone.project_id !== p.project_id || zone.env !== p.env) return 'ignored:zone';
        const start = Date.parse(p.window_start);
        if (p.window !== 'hour' || Date.parse(p.window_end) - start !== HOUR_MS || start % HOUR_MS !== 0) return 'ignored:window';
        if (start > s.now() + HOUR_MS) return 'ignored:future';
        const revision = p.revision || 1;
        const row = await db.maybe(`INSERT INTO zone_usage (zone_id, window_start, capability, unit, quantity, errors, revision, event_id, recorded_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (zone_id, window_start, capability, unit) DO UPDATE SET quantity = excluded.quantity, errors = excluded.errors,
                revision = excluded.revision, event_id = excluded.event_id, recorded_at = excluded.recorded_at
            WHERE zone_usage.revision <= excluded.revision
            RETURNING zone_id`, [zone.id, start, p.capability, p.unit, p.quantity, p.errors, revision, event.event_id, s.now()]);
        return row ? 'recorded' : 'ignored:stale';
    }

    async function series(zoneId, { from }) {
        const rows = await db.many(`SELECT capability, unit, SUM(quantity) AS quantity FROM zone_usage
            WHERE zone_id = $1 AND window_start >= $2 GROUP BY capability, unit ORDER BY capability, unit`, [zoneId, from]);
        const last = await db.value('SELECT MAX(window_start) FROM zone_usage WHERE zone_id = $1 AND window_start >= $2', [zoneId, from]);
        return {
            series: rows.slice(0, 32).map((r) => ({ capability: r.capability, unit: r.unit, quantity: Number(r.quantity) })),
            reportedUntil: last == null ? null : Number(last) + HOUR_MS,
        };
    }

    async function prune() {
        await db.exec('DELETE FROM zone_usage WHERE window_start < $1', [s.now() - KEEP_DAYS * 24 * HOUR_MS]);
    }

    return { apply, series, prune, TOPIC };
}

module.exports = { createUsage, TOPIC };
