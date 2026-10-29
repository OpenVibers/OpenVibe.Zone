'use strict';

/**
 * Page shell. Every page is server-rendered through openvibe-shared/shell and is complete without JavaScript:
 *   - <head>: title, description, canonical, robots (pages are noindex unless they say otherwise), Open Graph/Twitter,
 *     JSON-LD (openvibe-shared/seo), plus this service's extras: the shared app icon, the stylesheet, the boost marker
 *   - the OpenVibe Frame: theme-loader, web-runtime, navbar and footer scripts (the shell boots the
 *     navbar; the footer is initialised below), a <noscript> navigation bar and the server-rendered footer
 *   - the product's own script only where a page offers an in-browser convenience
 */
const crypto = require('crypto');
const ovServe = require('openvibe-shared/serve');
const fs = require('fs');
const path = require('path');
const appIcon = require('openvibe-shared/app-icon');
const frame = require('openvibe-shared/frame');
const shell = require('openvibe-shared/shell');
const cache = require('openvibe-shared/cache-policy');
const { html, raw, esc } = require('./html');

const NETWORK_URL = 'https://openvibe.network';
const SITE_NAME = 'OpenVibe.Zone';
const TAGLINE = 'Private S3-compatible storage';
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
// The product's own places: the main ones carry an icon (phones get them as the bottom tab bar), the rest fold into
// the navbar's More (Shared 4.22). Search is the navbar's magnifier and What shipped is the footer's.
const NAV = [
    { label: 'Zone', href: '/', icon: 'fa-house' },
    { label: 'Your projects', href: '/projects', icon: 'fa-diagram-project' },
    { label: 'Docs', href: '/docs', icon: 'fa-book' },
];

const hashes = new Map();
function assetVersion(rel) {
    if (hashes.has(rel)) return hashes.get(rel);
    let v = 'dev';
    try { v = crypto.createHash('sha256').update(fs.readFileSync(path.join(PUBLIC_DIR, rel))).digest('hex').slice(0, 10); } catch { /* missing asset */ }
    hashes.set(rel, v);
    return v;
}
const asset = (rel) => `/${rel}?v=${assetVersion(rel)}`;

// The deployed release (app.js sets it from openvibe-shared/release): openvibe-shared/boost swaps a page in place only
// between pages of the same release, and does a normal load across a deploy.
let RELEASE = 'dev';
function setRelease(id) { if (id) RELEASE = String(id); }

/**
 * o: title, description, body (html), viewer, config, path, index (default false), scripts [rel],
 *    crumbs [{ label, href }], jsonLd [nodes] (serialised by openvibe-shared/seo), styles [openvibe-shared stylesheet names]
 */
function renderPage(o) {
    const viewer = o.viewer || { kind: 'anonymous' };
    const signedIn = viewer.kind === 'user';
    const pathNow = o.path || '/';
    const loginNext = encodeURIComponent(pathNow);
    const canonical = `${o.config.baseUrl}${pathNow.split('?')[0]}`;
    const nav = {
        service: 'zone',
        apiBase: NETWORK_URL,
        links: NAV.map((l) => ({ label: l.label, href: l.href, ...(l.icon ? { icon: l.icon } : {}), ...(l.more ? { more: true } : {}), active: pathNow === l.href || pathNow.startsWith(`${l.href}/`) })),
        appBar: true,   // phones: the places with icons as the bottom tab bar (Shared 4.20)
        history: { type: 'page', title: o.title || SITE_NAME },
        silentLogin: `${o.config.baseUrl}/auth/login?silent=1&next={url}`,
        sessionUrl: '/auth/me',
        loginUrl: '/auth/login?next={path}',           // filled from the current page (boost moves between pages)
        logoutUrl: '/auth/logout?next={path}',   // Sign out in the shared navbar ends this site's session too
        notificationsRealtime: true,             // the bell hears new notifications over OpenVibe.Events (Shared 1.22.0)
    };
    const footer = { service: 'zone', variant: 'full', mount: '#ov-footer', brandName: SITE_NAME, updates: '/updates' };
    const account = signedIn
        ? html`Signed in as <strong>${viewer.displayName || viewer.username || 'you'}</strong> · <a href="/auth/logout?next=${loginNext}">Sign out</a>`
        : html`<a href="/auth/login?next=${loginNext}">Sign in with OpenVibe</a>`;
    const crumbs = (o.crumbs || []).length
        ? html`<nav class="crumbs" aria-label="Breadcrumbs">${o.crumbs.map((c, i) => html`${i ? ' / ' : ''}${c.href ? html`<a href="${c.href}">${c.label}</a>` : c.label}`)}</nav>`
        : '';
    const scripts = (o.scripts || []).map((rel) => html`<script src="${asset(rel)}" defer></script>`);
    return shell.page({
        name: SITE_NAME,
        lang: 'en',
        title: o.title || `${SITE_NAME}: ${TAGLINE}`,
        titleSuffix: o.title ? ` · ${SITE_NAME}` : '',
        siteName: SITE_NAME,
        description: o.description || `${SITE_NAME} — ${TAGLINE}`,
        canonical,
        robots: o.index ? 'index, follow' : 'noindex, nofollow',
        // A page with a Markdown twin (o.agent) advertises it in the head and the Link header; the twin itself
        // is server/agent-pages.js.
        agentLayer: o.agent === true,
        llms: `${String(o.config.baseUrl).replace(/\/+$/, '')}/llms.txt`,
        jsonLd: (o.jsonLd || []).filter(Boolean),
        home: '/',
        navLinks: NAV,
        navbar: nav,
        footer,
        head: `<meta name="referrer" content="${o.noReferrer ? 'no-referrer' : 'strict-origin-when-cross-origin'}">
${appIcon.headTags({ site: 'zone' })}
<link rel="stylesheet" href="${asset('css/app.css')}">
${(o.styles || []).map((name) => `<link rel="stylesheet" href="${esc(ovServe.url(name))}">`).join('\n')}
${render(scripts)}
<meta name="ov-boost" content="zone@${esc(RELEASE)}">
<script src="${ovServe.url('boost.js')}" data-main="#main" defer></script>`,
        body: `<a class="skip" href="#main">Skip to content</a>
<div id="navbar-mount"></div>
<noscript><div class="account-bar" role="navigation" aria-label="Account">${render(account)}</div></noscript>
<main id="main" class="page">
${render(crumbs)}
${render(o.body)}
${o.path === '/' ? frame.shipped({ service: 'zone', title: `Recently shipped on ${SITE_NAME}` }) : ''}
</main>
<script>
window.__OV_PAGE = ${JSON.stringify({ navbar: nav, footer }).replace(/</g, '\\u003c')};
document.addEventListener('DOMContentLoaded', function () {
  try { if (window.OpenVibeFooter) OpenVibeFooter.init(window.__OV_PAGE.footer); } catch (e) { /* the Frame is optional */ }
});
</script>`,
    });
}

function render(v) { return require('./html').render(v); }

/** Send a page; a page rendered for a signed-in person is private and never cached. */
function send(res, status, o) {
    // A page rendered for a signed-in person names them in the account bar: never shared caches.
    const personal = o.viewer && o.viewer.kind === 'user';
    if (!res.get('Cache-Control')) res.set('Cache-Control', !personal && o.cache ? o.cache : cache.htmlHeaders({ private: true }));
    res.set('Vary', 'Cookie');
    if (o.agent) {
        const site = String(o.config.baseUrl).replace(/\/+$/, '');
        res.set('Link', require('openvibe-shared/agent-layer').linkHeaderTags(`${site}${String(o.path || '/').split('?')[0]}`, `${site}/llms.txt`).header);
    }
    res.status(status).type('html').send(renderPage(o));
}

module.exports = { renderPage, send, asset, assetVersion, setRelease, SITE_NAME, NETWORK_URL, NAV, raw, html };
