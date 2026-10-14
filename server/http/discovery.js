'use strict';

/**
 * Crawl artifacts for openvibe.zone, built with openvibe-shared/seo: robots.txt, sitemap.xml, llms.txt and
 * llms-full.txt, and the home page's JSON-LD. The public pages (home, docs, updates) are for search engines and AI
 * crawlers; sign-in, a person's projects and the API are not.
 */
const fs = require('fs');
const path = require('path');
const seo = require('openvibe-shared/seo');
const cache = require('openvibe-shared/cache-policy');
const { asyncRouter } = require('./router');

const SITE_NAME = 'OpenVibe.Zone';
const DESCRIPTION = 'OpenVibe.Zone: private S3-compatible storage zones for your OpenVibe projects.';
const DISALLOW = ['/auth/', '/api/', '/projects', '/p/'];

const PAGE_TEXT = {
    '/': ['OpenVibe.Zone home', 'Private storage zones for each project and environment, reached with any S3 tool and scoped access keys.'],
    '/docs': ['Using OpenVibe.Zone', 'The S3 endpoint and its operations, access keys, and the zone API.'],
    '/updates': ['What shipped on OpenVibe.Zone', 'This site\'s update log, from the network changelog feed.'],
};

function dayOf(ts) {
    const m = String(ts == null ? '' : ts).match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
}
function siteUpdated() {
    try { return dayOf(JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'STATUS.json'), 'utf8')).updated); } catch { return null; }
}

function homeJsonLd(config) {
    const site = String(config.baseUrl).replace(/\/+$/, '');
    return [
        seo.jsonLd.website({ name: SITE_NAME, url: site, description: DESCRIPTION }),
        seo.jsonLd.webPage({ name: SITE_NAME, url: `${site}/`, description: DESCRIPTION, siteUrl: site }),
    ];
}

const publicPages = () => [
    { path: '/', changefreq: 'weekly', priority: 1.0 },
    { path: '/docs', changefreq: 'monthly', priority: 0.6 },
    { path: '/updates', changefreq: 'daily', priority: 0.4 },
];
function createDiscoveryRoutes(ctx) {
    const { config } = ctx;
    const r = asyncRouter();
    const site = String(config.baseUrl).replace(/\/+$/, '');
    const abs = (p) => `${site}${p}`;
    const TEXT = cache.htmlHeaders({ maxAge: 3600 });

    r.get('/robots.txt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', TEXT).send(
            '# openvibe.zone: the public pages are for search and AI crawlers; sign-in, projects and the API are not.\n'
            + seo.robotsTxt({ sitemaps: [abs('/sitemap.xml')], disallow: DISALLOW }));
    });

    r.get('/llms.txt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', TEXT).send(seo.llmsTxt({
            name: SITE_NAME,
            summary: DESCRIPTION,
            details: `A zone is an S3 bucket of one OpenVibe project environment (sandbox or production). Zones are made here or `
                + `with the API; access keys read, write or both and may be limited to some zones; any S3 tool reaches them at `
                + `${config.media.s3Endpoint} (path style, SigV4). A zone's name is never reused. Every page is server-rendered.`,
            sections: [
                { title: 'Start here', links: [
                    { title: 'OpenVibe.Zone', url: abs('/'), note: 'what a zone is, and the tools that reach one' },
                    { title: 'Using OpenVibe.Zone', url: abs('/docs'), note: 'the S3 endpoint, access keys and the API' },
                    { title: 'What shipped on OpenVibe.Zone', url: abs('/updates') },
                ] },
                { title: 'Machine-readable', links: [
                    { title: 'Sitemap', url: abs('/sitemap.xml') },
                    { title: 'Full text for language models', url: abs('/llms-full.txt') },
                    { title: 'Release metadata (JSON)', url: abs('/release.json') },
                ] },
                { title: 'Elsewhere', links: [
                    { title: 'OpenVibe.Services', url: 'https://openvibe.services', note: 'projects, apps and every resource' },
                    { title: 'OpenVibe.Media', url: 'https://openvibe.media', note: 'the objects inside every zone' },
                    { title: 'OpenVibe.Network', url: 'https://openvibe.network', note: 'accounts, apps and grants' },
                ] },
            ],
        }));
    });

    r.get('/llms-full.txt', (_req, res) => {
        const pages = publicPages().map((e) => ({ url: e.path, title: PAGE_TEXT[e.path][0], text: PAGE_TEXT[e.path][1] }));
        res.type('text/plain').set('Cache-Control', TEXT).send(seo.llmsFull({
            site: SITE_NAME, summary: 'Every public page of OpenVibe.Zone, one line each.', base: site, maxBytes: 64 * 1024,
            sections: [{ title: 'Pages', pages }],
        }));
    });

    r.get('/sitemap.xml', (_req, res) => {
        const lastmod = siteUpdated();
        res.type('application/xml').set('Cache-Control', TEXT).send(seo.sitemapXml(publicPages().map((e) => ({ loc: abs(e.path), ...(lastmod ? { lastmod } : {}), changefreq: e.changefreq, priority: e.priority }))));
    });

    return r;
}

module.exports = { createDiscoveryRoutes, homeJsonLd, publicPages, DESCRIPTION, SITE_NAME };
