'use strict';

/**
 * Sharing for Zone buckets (design 2026-11-06, VISIBILITY-EVERYWHERE step 4; openvibe-sdk/share).
 *
 * The SDK owns the model and the rules: the `shares` row next to each bucket, the one access check
 * (canView), members, access requests, transfers, the append-only log and the delivery queue. This
 * file is the wiring a service supplies:
 *
 *   - network.json       Network's identity lookups (@name → subject, and a person's card for the sheet)
 *   - events.publish     OpenVibe.Events, so share.* envelopes go out like every other event
 *   - notify             Network's notification push; a refusal is logged, never allowed to stall the queue
 *   - onAudienceChange   leaves the zone alone (a bucket is private storage: its access is its S3 keys), so only the share
 *                        row decides who may read its console page
 *   - onOwnerChange      moves zone_zones.created_by to the new owner
 *
 * A bucket is Only me. The sheet on it can name a teammate ("look at this before I hand over the
 * keys"); a bucket is never Everyone or a public link, because its objects are the project's, not
 * a page's. The project's members keep the S3 access they always had.
 */
const { createShares, ShareError } = require('openvibe-sdk/share');
const { serviceAuth } = require('openvibe-contracts');

const SERVICE = 'zone';
const KIND = 'zone';
const AUDIENCES = ['people', 'private'];
/** A bucket has no public audience: any narrowing or widening is Only me or the people on its list. */
const TO_SDK = { public: 'private', unlisted: 'private', people: 'people', private: 'private' };
const FROM_SDK = { public: 'private', link: 'private', people: 'people', private: 'private' };

const refOf = (id) => ({ service: SERVICE, kind: KIND, id: String(id) });

/** Blog's viewer as the SDK wants it: a subject object, and the staff bit. */
function shareViewer(v) {
    if (!v || !v.subject) return null;
    if (String(v.subject).startsWith('usr_')) return { subject: { type: 'user', id: v.subject }, staff: !!v.staff };
    if (String(v.subject).startsWith('gst_')) return { subject: { type: 'guest', id: v.subject }, staff: !!v.staff };
    return null;
}

function createSharing({ db, config, now = Date.now, fetchImpl = globalThis.fetch, log = console } = {}) {
    // Zone has no generic outbox for arbitrary envelopes: share.* events go to Events with their own token.
    const eventsToken = config.events && config.events.url && config.oauth && config.oauth.clientSecret ? serviceAuth.createTokenClient({
        tokenUrl: `${String(config.networkInternalUrl || config.networkUrl).replace(/\/+$/, '')}/oauth/token`,
        clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, audience: 'openvibe.events', scope: 'events.event.publish', fetchImpl,
    }) : null;
    async function publish(envelope) {
        if (!eventsToken) return;
        const res = await fetchImpl(config.events.url, { method: 'POST', headers: { ...(await eventsToken.authHeaders()), 'Content-Type': 'application/json' },
            body: JSON.stringify(envelope), signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error(`Events answered ${res.status}`);
    }
    const base = String(config.networkInternalUrl || config.networkUrl || '').replace(/\/+$/, '');
    const tokens = config.oauth && config.oauth.clientSecret ? serviceAuth.createTokenClient({
        tokenUrl: `${base}/oauth/token`,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.network',
        scope: 'identity.subject.resolve network.notifications.push',
        fetchImpl,
    }) : null;

    async function networkJson({ path, method = 'GET', json, query } = {}) {
        if (!tokens) throw new Error('Network is not configured for this service');
        const url = new URL(`${base}${path}`);
        for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, String(v));
        const headers = { Accept: 'application/json', ...(await tokens.authHeaders()) };
        if (json !== undefined) headers['Content-Type'] = 'application/json';
        const res = await fetchImpl(url, { method, headers, body: json === undefined ? undefined : JSON.stringify(json), signal: AbortSignal.timeout(8000) });
        const body = await res.json().catch(() => null);
        if (!res.ok) {
            const err = new Error(`Network ${method} ${path} ${res.status}: ${(body && (body.detail || body.error)) || 'failed'}`);
            err.status = res.status;
            throw err;
        }
        return body;
    }

    /** One notification, addressed by canonical subject. It never carries a post's title or text. */
    async function notify(n) {
        const to = n && n.to;
        if (!to || to.type !== 'user') return;
        const words = {
            'share.added': ['A bucket was shared with you', 'Open it on OpenVibe.Zone.'],
            'share.access_requested': ['Someone asked for access to your bucket', 'Review the request on OpenVibe.Zone.'],
            'share.transfer.requested': ['Someone wants to give you a bucket', 'Accept or decline it on OpenVibe.Zone.'],
            'share.transfer.answered': ['A bucket transfer was answered', 'See what happened on OpenVibe.Zone.'],
        }[n.kind] || ['Sharing on OpenVibe.Zone', 'There is something new for you.'];
        try {
            await networkJson({
                path: '/internal/notifications/push', method: 'POST',
                json: {
                    subject: to.id, type: 'GENERIC', title: words[0], message: words[1],
                    service: 'zone', url: config.baseUrl,
                    category: 'social',
                },
            });
        } catch (err) {
            log.warn('[Sharing] notification not sent:', err.message);
        }
    }



    async function onOwnerChange(ref, from, to, tx) {
        if (ref.service !== SERVICE || ref.kind !== KIND) return;
        const owner = to && to.type === 'user' ? to.id : null;
        await tx.exec('UPDATE zone_zones SET created_by = $1 WHERE id = $2', [owner, ref.id]);
    }

    const shares = createShares({
        db,
        network: { json: networkJson },
        events: { publish },
        notify,
        onOwnerChange,
    });

    // A bucket has no public audience: the sheet offers two, and a hand-made request cannot widen it.
    const onlyPeopleOrPrivate = (body) => {
        if (body && body.audience !== undefined && !['people', 'private'].includes(body.audience)) {
            throw new ShareError(400, 'share.invalid', 'A bucket can be shared with specific people or only you');
        }
    };
    const rawUpdate = shares.update, rawSetAudience = shares.setAudience;
    shares.update = (viewer, ref, body, opts) => { onlyPeopleOrPrivate(body); return rawUpdate(viewer, ref, body, opts); };
    shares.setAudience = (viewer, ref, audience) => {
        if (!['people', 'private'].includes(audience)) throw new ShareError(400, 'share.invalid', 'A bucket can be shared with specific people or only you');
        return rawSetAudience(viewer, ref, audience);
    };

    const sv = (viewer) => shareViewer(viewer);
    const at = (id) => refOf(id);

    async function defaultFor(subject) {
        const row = await db.maybe('SELECT audience FROM zone_share_defaults WHERE subject = $1', [subject]);
        return row ? row.audience : 'private';
    }

    async function saveDefault(subject, audience, { apply = false } = {}) {
        if (!/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(subject || '')) || !AUDIENCES.includes(audience)) {
            throw new ShareError(400, 'share.invalid', 'Choose Specific people or Only me');
        }
        await db.exec(`INSERT INTO zone_share_defaults (subject, audience, updated_at) VALUES ($1, $2, now())
            ON CONFLICT (subject) DO UPDATE SET audience = EXCLUDED.audience, updated_at = EXCLUDED.updated_at`, [subject, audience]);
        let applied = 0;
        if (apply) {
            // A bucket belongs to a project, but its Share sheet belongs to its maker (or transferee).
            // Never change the project's default buckets or a teammate's named buckets.
            const rows = await db.many(`SELECT z.id FROM zone_zones z JOIN shares s
                ON s.service = $1 AND s.kind = $2 AND s.resource_id = z.id
                WHERE s.owner_subject->>'type' = 'user' AND s.owner_subject->>'id' = $3
                  AND NOT z.is_default AND z.state NOT IN ('deleting', 'deleted') ORDER BY z.id`, [SERVICE, KIND, subject]);
            for (const row of rows) {
                await shares.setAudience(sv({ subject }), at(row.id), audience);
                applied++;
            }
        }
        return { audience, applied };
    }

    return {
        shares,
        SERVICE,
        KIND,
        AUDIENCES,
        refOf,
        shareViewer,
        defaultFor,
        saveDefault,
        /** Register a post with the sharing system (inside the post's own transaction). */
        register: async (viewer, id, audience = 'private') => await shares.register(at(id), {
            owner_subject: viewer && viewer.subject ? { type: String(viewer.subject).startsWith('gst_') ? 'guest' : 'user', id: viewer.subject } : { type: 'service', id: SERVICE },
            audience: TO_SDK[audience] || 'private',
        }),
        /**
         * The service's own audience move (a create form, the editor's select, a publish). The caller
         * has already passed access.canWrite and owns the column and the Search sync; this only keeps
         * the share row in step. The SDK's owner check is for people using the sheet.
         */
        syncAudience: async (id, audience) => {
            const next = TO_SDK[audience] || 'private';
            await db.tx(async (t) => {
                const row = await t.maybe('SELECT audience FROM shares WHERE service = $1 AND kind = $2 AND resource_id = $3 FOR UPDATE', [SERVICE, KIND, String(id)]);
                if (!row || row.audience === next) return;
                await t.exec('UPDATE shares SET audience = $1, revision = revision + 1 WHERE service = $2 AND kind = $3 AND resource_id = $4', [next, SERVICE, KIND, String(id)]);
            });
        },
        shareOf: async (id) => await db.maybe('SELECT * FROM shares WHERE service = $1 AND kind = $2 AND resource_id = $3', [SERVICE, KIND, String(id)]),
        canView: async (viewer, id) => await shares.canView(sv(viewer), at(id)),
        canEdit: async (viewer, id) => await shares.canEdit(sv(viewer), at(id)),
        get: async (viewer, id) => await shares.get(sv(viewer), at(id)),
        getWithRevision: async (viewer, id) => await shares.getWithRevision(sv(viewer), at(id)),
        setAudience: async (viewer, id, audience) => await shares.setAudience(sv(viewer), at(id), TO_SDK[audience] || 'private'),
        addMembers: async (viewer, id, list) => await shares.addMembers(sv(viewer), at(id), list),
        removeMember: async (viewer, id, subject) => await shares.removeMember(sv(viewer), at(id), subject),
        update: async (viewer, id, body, opts) => await shares.update(sv(viewer), at(id), body, opts),
        requestAccess: async (viewer, id) => await shares.requestAccess(sv(viewer), at(id)),
        dismiss: async (viewer, id, requestId) => await shares.dismiss(sv(viewer), at(id), requestId),
        transfer: async (viewer, id, input) => await shares.transfer(sv(viewer), at(id), input),
        accept: async (viewer, id, transferId) => await shares.accept(sv(viewer), at(id), transferId),
        decline: async (viewer, id, transferId) => await shares.decline(sv(viewer), at(id), transferId),
        cancel: async (viewer, id, transferId) => await shares.cancel(sv(viewer), at(id), transferId),
        lookup: async (viewer, name) => await shares.lookup(sv(viewer), name),
        sharedWithMe: async (viewer, opts) => await shares.sharedWithMe(sv(viewer), { service: SERVICE, ...(opts || {}) }),
        /** Expire members and transfers, then send queued events and notifications. */
        work: async ({ flush = true } = {}) => {
            let expired = 0;
            try { expired = await shares.expireMembers(); } catch (err) { log.warn('[Sharing] expiry sweep:', err.message); }
            let sent = 0;
            if (flush) { try { sent = await shares.flush(); } catch (err) { log.warn('[Sharing] deliveries:', err.message); } }
            return { expired, sent };
        },
    };
}

/** The uniform API's describe(ref): the sheet shows the post's title and link to its owner. */
function describeRef(db, config) {
    return async (ref) => {
        if (ref.service !== SERVICE || ref.kind !== KIND) return {};
        const zone = await db.maybe('SELECT id, project_id, name, env FROM zone_zones WHERE id = $1', [ref.id]);
        if (!zone) return {};
        return {
            title: `${zone.name} (${zone.env})`,
            link: `${String(config.baseUrl || '').replace(/\/+$/, '')}/p/${zone.project_id}#${zone.id}`,
            roles: ['viewer'],
            audiences: AUDIENCES,
            transferable: true,
        };
    };
}

module.exports = { createSharing, describeRef, shareViewer, refOf, AUDIENCES, TO_SDK, FROM_SDK, SERVICE, KIND };
