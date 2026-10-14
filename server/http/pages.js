'use strict';

/**
 * OpenVibe.Zone's pages, server-rendered and usable without JavaScript:
 *
 *   /                          what a zone is, how to use one with any S3 tool
 *   /projects                  a signed-in person's projects (from Network, with their own token)
 *   /p/:project                one project: its zones per environment with their usage, and its S3 access keys;
 *                              admins and owners create and delete zones, issue and revoke keys (forms below)
 *   POST /p/:project/zones                        create a zone
 *   POST /p/:project/zones/:zone/delete           delete a zone and every object in it (the name must be typed)
 *   POST /p/:project/keys                         issue an access key (its secret is shown on the page it returns, once)
 *   POST /p/:project/keys/:key/revoke             revoke a key
 *   /docs                      the API and S3 usage
 *   /updates                   the update log
 *
 * Every form is a same-origin POST from a signed-in person; Zone and Media both check that the person administers
 * the project. A key's secret is in the response to its issue only: never stored here, never logged.
 */
const express = require('express');
const ovServe = require('openvibe-shared/serve');
const frame = require('openvibe-shared/frame');
const showcase = require('openvibe-shared/showcase');
const cache = require('openvibe-shared/cache-policy');
const { asyncRouter } = require('./router');
const { createDiscoveryRoutes, homeJsonLd } = require('./discovery');
const { sameOrigin } = require('./principal');
const { html, raw } = require('../render/html');
const { send } = require('../render/layout');
const { ZoneError, RESERVED } = require('../zone/zones');
const { ClientError } = require('../zone/clients');

const SITE_NAME = 'OpenVibe.Zone';
const PROJECT_RE = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/;
const ZONE_RE = /^zon_[0-9A-HJKMNP-TV-Z]{26}$/;
const KEY_RE = /^ovk_[0-9A-HJKMNP-TV-Z]{26}$/;
const ADMIN = new Set(['admin', 'owner']);

function bytes(n) {
    const v = Number(n) || 0;
    if (v < 1024) return `${v} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let x = v / 1024, i = 0;
    while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
    return `${x >= 10 ? Math.round(x) : x.toFixed(1)} ${units[i]}`;
}
const plural = (n, one, many) => `${Number(n).toLocaleString('en-US')} ${n === 1 ? one : many}`;
const day = (iso) => (iso ? String(iso).slice(0, 10) : '—');

function createPageRoutes(ctx) {
    const { config, clients, zones } = ctx;
    const r = asyncRouter();
    const form = express.urlencoded({ extended: false, limit: '8kb' });
    const PUBLIC_CACHE = cache.htmlHeaders({ maxAge: 300 });
    const page = (req, res, o, status = 200) => send(res, status, { viewer: req.viewer, config, path: req.originalUrl, ...o });
    const person = (req) => (req.viewer && req.viewer.kind === 'user' && /^usr_/.test(String(req.viewer.subject || '')) ? req.viewer : null);
    const s3 = config.media.s3Endpoint;

    const signInPage = (req, res, next) => page(req, res, {
        title: 'Sign in', body: html`<h1>Sign in to manage your zones</h1>
<p>Your zones belong to your OpenVibe projects. Sign in with your OpenVibe account to see them.</p>
<p><a class="zn-button zn-primary" href="/auth/login?next=${encodeURIComponent(next)}">Sign in with OpenVibe</a></p>`,
    }, 401);

    // ── Home ─────────────────────────────────────────────────
    r.get('/', (req, res) => {
        const me = person(req);
        const hero = showcase.hero({
            eyebrow: `${SITE_NAME} · part of OpenVibe`,
            title: 'Private storage zones',
            accent: 'S3 buckets for your projects.',
            lede: 'Named zones for each project and environment. The AWS SDKs, rclone and backup tools reach them over S3, with access keys you scope to a zone and quotas you set. Every object is an OpenVibe.Media object, readable through its API too.',
            actions: me
                ? [{ label: 'Your projects', href: '/projects', primary: true }, { label: 'How to use it', href: '/docs' }]
                : [{ label: 'Sign in to start', href: '/auth/login?next=%2Fprojects', primary: true }, { label: 'How to use it', href: '/docs' }],
            note: 'Each project includes 1 GB in production and 100 MB in its sandbox at no charge.',
        });
        page(req, res, {
            index: true, cache: me ? null : PUBLIC_CACHE, jsonLd: homeJsonLd(config), styles: [showcase.STYLESHEET],
            body: html`${raw(hero)}
${raw(showcase.steps({
                title: 'From nothing to a bucket',
                items: [
                    { title: 'Pick a project', text: 'Zones belong to an OpenVibe project. Make one on OpenVibe.Services if you have none.', href: 'https://openvibe.services/' },
                    { title: 'Create a zone', text: 'A zone is a bucket: a name in one environment, sandbox or production, with an optional quota.' },
                    { title: 'Issue an access key', text: 'Read, write or both, for every zone of the environment or only some. The secret is shown once.' },
                    { title: 'Use any S3 tool', text: `Point it at ${s3} with path-style addressing.`, href: '/docs' },
                ],
            }))}
<section class="zn-section" aria-labelledby="zn-try"><h2 id="zn-try">With the tools you have</h2>
<pre class="zn-code"><code>aws configure set aws_access_key_id ovk_…
aws configure set aws_secret_access_key …
aws --endpoint-url ${s3} s3 cp ./site s3://assets/ --recursive
aws --endpoint-url ${s3} s3 ls s3://assets/</code></pre>
<pre class="zn-code"><code>rclone config create oz s3 provider Other endpoint ${s3} \\
  access_key_id ovk_… secret_access_key … no_check_bucket true
rclone sync ./backups oz:backups</code></pre>
<p class="zn-muted">Objects go up in one request (multipart uploads are not supported yet), up to 100 MB each.</p>
</section>
<section class="zn-section" aria-labelledby="zn-what"><h2 id="zn-what">What a zone gives you</h2>
<ul class="zn-list">
<li><strong>Private by default.</strong> A named zone's objects are reached only with a signed request or a presigned URL, never a public link.</li>
<li><strong>Names that stay yours.</strong> A zone's name is never given to another zone, even after it is deleted, so a URL signed for one bucket can never reach a different one.</li>
<li><strong>Scoped keys.</strong> A key reads, writes or both, in one environment, for every zone or only the ones you name. Revoking it takes effect at once.</li>
<li><strong>Quotas you set.</strong> Each zone may have its own ceiling below the environment's.</li>
<li><strong>One deletion path.</strong> Deleting a zone removes every object and every copy of it.</li>
</ul></section>`,
        });
    });

    // ── A person's projects ──────────────────────────────────
    r.get('/projects', async (req, res) => {
        const me = person(req);
        if (!me) return signInPage(req, res, '/projects');
        let projects;
        try { projects = (await clients.projectsOf(me.token)).filter((p) => !p.archived_at); } catch (err) {
            return page(req, res, { title: 'Your projects', body: html`<h1>Your projects</h1><p class="zn-error">Your projects could not be read just now (${err.message}). Try again in a moment.</p>` }, 503);
        }
        page(req, res, {
            title: 'Your projects',
            body: html`<h1>Your projects</h1>
${projects.length ? html`<ul class="zn-cards">${projects.map((p) => html`<li class="zn-card"><h2><a href="/p/${p.id}">${p.name}</a></h2>
<p class="zn-muted">${p.role || 'member'} · ${(p.environments || ['sandbox']).join(' and ')}</p></li>`)}</ul>`
        : html`<p>You are not in any project yet. Make one on <a href="https://openvibe.services/">OpenVibe.Services</a>, then come back to give it zones.</p>`}`,
        });
    });

    // ── One project ──────────────────────────────────────────
    async function projectView(req, res, project, { notice = null, secret = null, error = null } = {}) {
        const me = person(req);
        if (!me) return signInPage(req, res, `/p/${project}`);
        if (!PROJECT_RE.test(project)) return page(req, res, { title: 'Not found', body: html`<h1>Not found</h1><p>No such project.</p>` }, 404);
        let role, projects;
        try {
            projects = await clients.projectsOf(me.token);
            role = await clients.memberRole(project, me.subject);
        } catch (err) {
            return page(req, res, { title: 'Project', body: html`<h1>Project</h1><p class="zn-error">Network could not be asked about this project (${err.message}). Try again in a moment.</p>` }, 503);
        }
        const p = projects.find((x) => x.id === project);
        if (!p || !role) return page(req, res, { title: 'Not found', body: html`<h1>Not found</h1><p>No such project of yours. <a href="/projects">Your projects</a>.</p>` }, 404);
        const admin = ADMIN.has(role);
        const envs = p.environments && p.environments.length ? p.environments : ['sandbox'];
        for (const env of envs) await zones.ensureDefault(project, env);
        const list = (await zones.list(project, {})).zones;
        const usage = new Map();
        await Promise.all(list.filter((z) => z.state !== 'deleted').map(async (z) => {
            const rep = await clients.report(z.id).catch(() => null);
            if (rep) usage.set(z.id, rep);
        }));
        let keys = [];
        let keysError = null;
        if (admin) { try { keys = await clients.listKeys(project, me.subject); } catch (err) { keysError = err.message; } }
        const zoneRow = (z) => {
            const rep = usage.get(z.id);
            const u = rep && rep.usage;
            return html`<tr id="${z.id}"><td><code>${z.name}</code>${z.default ? html` <span class="zn-badge">default</span>` : ''}</td><td>${z.state}</td>
<td class="zn-n">${u ? `${bytes(u.stored_bytes)} · ${plural(u.objects, 'object', 'objects')}` : '—'}</td>
<td class="zn-n">${z.quota_bytes ? bytes(z.quota_bytes) : (z.default ? 'environment' : '—')}</td><td>${day(z.created_at)}</td>
<td>${admin && !z.default && z.state === 'active' ? html`<details><summary>Delete</summary><form method="post" action="/p/${project}/zones/${z.id}/delete">
<p>This deletes every object in <code>${z.name}</code>, with no undo, and the name can never be used again.</p>
<label>Type the zone's name to confirm <input name="confirm" required autocomplete="off" pattern="${z.name}"></label>
<button class="zn-button zn-danger" type="submit">Delete ${z.name}</button></form></details>` : ''}</td></tr>`;
        };
        const envSection = (env) => {
            const mine = list.filter((z) => z.env === env);
            return html`<section class="zn-section" aria-labelledby="zn-env-${env}"><h2 id="zn-env-${env}">${env === 'production' ? 'Production' : 'Sandbox'}</h2>
<table class="zn-table"><thead><tr><th scope="col">Zone (bucket)</th><th scope="col">State</th><th scope="col" class="zn-n">Stored</th><th scope="col" class="zn-n">Quota</th><th scope="col">Created</th><th scope="col"><span class="zn-sr">Actions</span></th></tr></thead>
<tbody>${mine.map(zoneRow)}</tbody></table>
${admin ? html`<form class="zn-form" method="post" action="/p/${project}/zones"><input type="hidden" name="env" value="${env}">
<label>New zone <input name="name" required minlength="3" maxlength="63" pattern="[a-z0-9]+(-[a-z0-9]+)*" placeholder="assets" autocomplete="off"></label>
<label>Quota (MB, optional) <input name="quota_mb" type="number" min="1" step="1" inputmode="numeric"></label>
<button class="zn-button" type="submit">Create zone</button></form>` : ''}</section>`;
        };
        const keysSection = admin ? html`<section class="zn-section" aria-labelledby="zn-keys"><h2 id="zn-keys">S3 access keys</h2>
${keysError ? html`<p class="zn-error">The keys could not be read just now (${keysError}).</p>` : ''}
${keys.length ? html`<table class="zn-table"><thead><tr><th scope="col">Name</th><th scope="col">Key id</th><th scope="col">Environment</th><th scope="col">Can</th><th scope="col">Zones</th><th scope="col">Last used</th><th scope="col"><span class="zn-sr">Actions</span></th></tr></thead>
<tbody>${keys.map((k) => html`<tr class="${k.revoked_at ? 'zn-revoked' : ''}"><td>${k.name}</td><td><code>${k.id}</code></td><td>${k.env}</td><td>${k.permissions}</td>
<td>${k.zones.length ? k.zones.map((id) => (list.find((z) => z.id === id) || {}).name || id).join(', ') : 'every zone'}</td><td>${day(k.last_used_at)}</td>
<td>${k.revoked_at ? `revoked ${day(k.revoked_at)}` : html`<form method="post" action="/p/${project}/keys/${k.id}/revoke"><button class="zn-button zn-danger" type="submit">Revoke</button></form>`}</td></tr>`)}</tbody></table>`
        : html`<p class="zn-muted">No keys yet.</p>`}
<form class="zn-form" method="post" action="/p/${project}/keys">
<label>Name <input name="name" required maxlength="80" placeholder="ci deploys" autocomplete="off"></label>
<label>Environment <select name="env">${envs.map((e) => html`<option value="${e}">${e}</option>`)}</select></label>
<label>Can <select name="permissions"><option value="read-write">read and write</option><option value="read">read</option><option value="write">write</option></select></label>
<fieldset><legend>Zones (none ticked: every zone of the environment)</legend>${list.filter((z) => z.state === 'active').map((z) => html`<label class="zn-check"><input type="checkbox" name="zones" value="${z.id}"> ${z.name} (${z.env})</label>`)}</fieldset>
<button class="zn-button" type="submit">Issue key</button></form></section>` : html`<p class="zn-muted">Only an admin or owner of this project manages its zones and keys.</p>`;
        page(req, res, {
            title: `${p.name}: zones`,
            body: html`<nav class="crumbs" aria-label="Breadcrumbs"><a href="/projects">Your projects</a> / ${p.name}</nav>
<h1>${p.name}</h1>
${notice ? html`<p class="zn-notice" role="status">${notice}</p>` : ''}
${error ? html`<p class="zn-error" role="alert">${error}</p>` : ''}
${secret ? html`<div class="zn-secret" role="alert"><h2>Your new key</h2><p>Copy the secret now: it is shown only once.</p>
<dl><dt>Access key id</dt><dd><code>${secret.key.id}</code></dd><dt>Secret access key</dt><dd><code>${secret.secret}</code></dd><dt>Endpoint</dt><dd><code>${s3}</code> (path style, region <code>us-east-1</code>)</dd></dl></div>` : ''}
${envs.map(envSection)}
${keysSection}
<p class="zn-muted">Endpoint: <code>${s3}</code>. <a href="/docs">How to use it</a>.</p>`,
            cache: null,
        }, error ? 400 : 200);
    }
    r.get('/p/:project', (req, res) => projectView(req, res, req.params.project));

    /** A form post: signed in, same origin, an admin; then the action, then the project page again. */
    function action(fn) {
        return [form, async (req, res) => {
            const project = req.params.project;
            const me = person(req);
            if (!me) return signInPage(req, res, `/p/${project}`);
            if (!sameOrigin(req, config.baseUrl)) return page(req, res, { title: 'Refused', body: html`<h1>Refused</h1><p>A change must come from this site's own page.</p>` }, 403);
            if (!PROJECT_RE.test(project)) return page(req, res, { title: 'Not found', body: html`<h1>Not found</h1>` }, 404);
            try {
                const role = await clients.memberRole(project, me.subject);
                if (!ADMIN.has(role)) return page(req, res, { title: 'Refused', body: html`<h1>Refused</h1><p>Only an admin or owner of this project changes its zones and keys.</p>` }, 403);
                const out = await fn(req, me, project);
                return await projectView(req, res, project, out);
            } catch (err) {
                if (err instanceof ZoneError || err instanceof ClientError) return await projectView(req, res, project, { error: err.detail || err.message });
                throw err;
            }
        }];
    }

    r.post('/p/:project/zones', ...action(async (req, me, project) => {
        const b = req.body || {};
        const name = String(b.name || '').trim().toLowerCase();
        if (RESERVED.has(name)) throw new ZoneError(400, 'zone.name_reserved', `${name} is reserved`);
        const quotaMb = b.quota_mb ? Number(b.quota_mb) : null;
        if (quotaMb !== null && !(Number.isInteger(quotaMb) && quotaMb >= 1)) throw new ZoneError(400, 'zone.bad_request', 'the quota is a whole number of MB');
        const out = await zones.create(project, { env: b.env, name, ...(quotaMb ? { quota_bytes: quotaMb * 1024 * 1024 } : {}) }, { caller: `user:${me.subject}` });
        return { notice: `Zone ${out.zone.name} is ${out.zone.state === 'active' ? 'ready' : 'being set up'} in ${out.zone.env}.` };
    }));

    r.post('/p/:project/zones/:zone/delete', ...action(async (req, me, project) => {
        if (!ZONE_RE.test(req.params.zone)) throw new ZoneError(404, 'zone.unknown', 'no such zone');
        const row = await zones.byId(req.params.zone);
        if (!row || row.project_id !== project) throw new ZoneError(404, 'zone.unknown', 'no such zone');
        if (String((req.body || {}).confirm || '') !== row.name) throw new ZoneError(400, 'zone.confirm', `type ${row.name} to delete it`);
        await zones.remove(row.id, { recursive: true });
        return { notice: `Zone ${row.name} is being deleted: it answers "no such bucket" already, and its objects are being erased.` };
    }));

    r.post('/p/:project/keys', ...action(async (req, me, project) => {
        const b = req.body || {};
        const picked = [].concat(b.zones || []).filter((z) => ZONE_RE.test(String(z)));
        const out = await clients.issueKey(project, { env: b.env, name: String(b.name || '').trim(), permissions: b.permissions || 'read-write', zones: picked, on_behalf_of: me.subject });
        return { notice: `Key ${out.key.name} is issued.`, secret: out };
    }));

    r.post('/p/:project/keys/:key/revoke', ...action(async (req, me, project) => {
        if (!KEY_RE.test(req.params.key)) throw new ZoneError(404, 'zone.unknown_key', 'no such key');
        const k = await clients.revokeKey(project, req.params.key, me.subject);
        return { notice: `Key ${k.name} is revoked: every request signed with it is refused from now on.` };
    }));

    // ── Docs ─────────────────────────────────────────────────
    r.get('/docs', (req, res) => page(req, res, {
        index: true, cache: PUBLIC_CACHE, title: 'Using OpenVibe.Zone',
        description: 'Create zones, issue S3 access keys and reach your buckets with the AWS SDKs, rclone and any S3 tool: the OpenVibe.Zone guide and API.',
        body: html`<h1>Using OpenVibe.Zone</h1>
<p class="zn-lede">A zone is an S3 bucket of one project environment. You make zones here or with the API, issue access keys, and point any S3 tool at <code>${s3}</code>.</p>
<h2 id="s3">The S3 endpoint</h2>
<ul class="zn-list">
<li><strong>Endpoint:</strong> <code>${s3}</code>, path style (<code>/&lt;zone&gt;/&lt;key&gt;</code>), region <code>us-east-1</code>, Signature Version 4.</li>
<li><strong>Operations:</strong>
  <ul>
    <li>objects: PutObject, GetObject (ranges), HeadObject, DeleteObject, DeleteObjects;</li>
    <li>listing: ListObjectsV2 and ListObjects (prefix, delimiter, pages), ListBuckets, HeadBucket;</li>
    <li>presigned GET and PUT URLs, valid for 7 days at most.</li>
  </ul></li>
<li><strong>Not yet supported:</strong> multipart uploads, CopyObject, ACLs, policies and versioning. Set your tool to upload in one request (AWS CLI: <code>aws configure set default.s3.multipart_threshold 100MB</code>; rclone: <code>upload_cutoff 100M</code>).</li>
<li><strong>Size:</strong> one object is at most 100 MB through this endpoint.</li>
<li><strong>Privacy:</strong> zones are private. Every request is signed. A presigned URL reaches only its own key, until it expires or its key is revoked.</li>
</ul>
<h2 id="keys">Access keys</h2>
<p>A key belongs to one project environment.</p>
<ul class="zn-list">
<li>It may read, write or both.</li>
<li>It may be limited to some zones; with none named, it reaches every zone of the environment.</li>
<li>Its secret is shown once, when it is issued. Revoking a key takes effect at once.</li>
<li>A key limited to one zone is revoked when that zone is deleted.</li>
</ul>
<h2 id="api">The API</h2>
<p>Base address: <code>${config.baseUrl}/api/v1</code>. Authenticate with a Network token: a developer app of the project (audience <code>openvibe.zone</code>, holding the route's capability; a sandbox app reaches only the sandbox), or a person who is a member of the project. Errors are RFC 9457 problem+json with a stable <code>code</code>.</p>
<ul class="zn-list">
<li><code>POST /projects/:project_id/zones</code> (<code>zone.zone.create</code>): <code>{ env, name, description?, quota_bytes? }</code> with an <code>Idempotency-Key</code> header. Answers 201 with the zone, or 409 with <code>zone.name_taken</code> or <code>zone.name_retired</code>.</li>
<li><code>GET /projects/:project_id/zones?env=&amp;include_deleted=&amp;cursor=&amp;limit=</code> (<code>zone.zone.list</code>).</li>
<li><code>GET /zones/:zone_id</code> (<code>zone.zone.read</code>): the zone with its stored bytes and objects.</li>
<li><code>PATCH /zones/:zone_id</code> (<code>zone.zone.manage</code>): <code>{ description?, quota_bytes? }</code>.</li>
<li><code>DELETE /zones/:zone_id?recursive=true</code> (<code>zone.zone.delete</code>). Without <code>recursive</code>, a zone that still holds objects answers <code>zone.not_empty</code>. A zone holding an object under a retention hold answers <code>zone.held</code>.</li>
<li><code>GET /zones/:zone_id/usage</code> (<code>zone.usage.read</code>).</li>
</ul>
<p>The objects of a zone are OpenVibe.Media objects. Media's own API (<code>/api/v2/:project_id/objects</code>, with <code>namespace</code> set to the zone's id) reads and writes the same objects.</p>`,
    }));

    r.get('/updates', (req, res) => page(req, res, {
        index: true, cache: PUBLIC_CACHE,
        title: `What shipped on ${SITE_NAME}`,
        body: raw(frame.updatesBody({ service: 'zone', siteName: SITE_NAME }) + `<script src="${ovServe.url('shipped.js')}" defer></script>`),
    }));

    // ── Discovery: robots.txt, sitemap.xml, llms.txt, llms-full.txt ──
    r.use(createDiscoveryRoutes(ctx));
    return r;
}

module.exports = { createPageRoutes };
