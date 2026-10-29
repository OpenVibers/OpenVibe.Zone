'use strict';
// The Markdown twins of openvibe.zone's public pages (openvibe-shared/agent-layer), rendered by the same page
// builders the routes use (createPageRoutes().publicViews + render/layout.js's renderPage), so a twin cannot
// drift from its page. Anonymous only: /projects and /p/:project are a signed-in person's, and get no twin.
const { renderPage } = require('./render/layout');

function createAgentPages(ctx, publicViews) {
    const twin = (page, path) => (page ? { html: renderPage({ ...page, viewer: { kind: 'anonymous' }, config: ctx.config, path }) } : null);

    async function renderPublicPage(path) {
        if (path === '/') return twin(await publicViews.home({ signed: false }), path);
        if (path === '/docs') return twin(await publicViews.docs(), path);
        if (path === '/updates') return twin(publicViews.updates(), path);
        return null;
    }

    return { renderPublicPage };
}

module.exports = { createAgentPages };
