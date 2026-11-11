'use strict';
/**
 * Account export and deletion → Zone (ADR-033; openvibe-sdk/account-data). What Zone holds about a person:
 *
 * - their telemetry: the requests they made against their zones, one aggregated sample per route and minute.
 *   The SDK covers that table itself (telemetry.json, then the subject NULL on deletion);
 *
 * and nothing else. The zones belong to a project environment, the usage is counted per zone, hour and series,
 * and the idempotency and control logs name the caller (a service), not a person. So Zone's own table map is
 * empty, and the guard on every table with a person column has nothing left to find here.
 */
const { createAccountData, TOPICS } = require('openvibe-sdk/account-data');

// Zone keeps no table of its own about a person: the telemetry samples are the SDK's own (see above).
const TABLES = [];

/**
 * The sharing system's own rows (openvibe-sdk/share): the SDK's table map cannot name a jsonb subject
 * column, so they are exported and erased here, and the guard knows them by reason.
 */
async function extraExport(db, subject) {
    const defaults = await db.many('SELECT * FROM zone_share_defaults WHERE subject = $1', [subject]);
    const owned = await db.many("SELECT * FROM shares WHERE service = $1 AND owner_subject->>'id' = $2", ['zone', subject]);
    const member = await db.many("SELECT * FROM share_members WHERE service = $1 AND subject->>'id' = $2", ['zone', subject]);
    const asked = await db.many("SELECT * FROM share_access_requests WHERE service = $1 AND subject->>'id' = $2", ['zone', subject]);
    return [{ name: 'shares.json', content: { owned, member_of: member, requests: asked } },
        { name: 'share-defaults.json', content: defaults }];
}

async function extraErase(t, subjects) {
    for (const subject of subjects) {
        await t.exec('DELETE FROM zone_share_defaults WHERE subject = $1', [subject]);
        await t.exec("DELETE FROM share_members WHERE service = $1 AND subject->>'id' = $2", ['zone', subject]);
        await t.exec("DELETE FROM share_access_requests WHERE service = $1 AND subject->>'id' = $2", ['zone', subject]);
        await t.exec("DELETE FROM share_transfers WHERE service = $1 AND (from_subject->>'id' = $2 OR to_subject->>'id' = $2)", ['zone', subject]);
        await t.exec("DELETE FROM shares WHERE service = $1 AND owner_subject->>'id' = $2", ['zone', subject]);
        // A bucket stays with its project; its maker's id is the only thing about them left on it.
        await t.exec('UPDATE zone_zones SET created_by = NULL WHERE created_by = $1', [subject]);
    }
}

function create({ db, log = console } = {}) {
    return createAccountData({ db, service: 'zone', tables: TABLES, extraExport, extraErase, log });
}

module.exports = { create, TABLES, TOPICS };
