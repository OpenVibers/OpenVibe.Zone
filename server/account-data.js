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

function create({ db, log = console } = {}) {
    return createAccountData({ db, service: 'zone', tables: TABLES, log });
}

module.exports = { create, TABLES, TOPICS };
