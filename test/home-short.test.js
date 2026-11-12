'use strict';
/**
 * The home on a phone (the owner's short-pages rule, 2026-10-30): the code samples are one pick block, a row of
 * chips picks one of them, and the parts a reader rarely needs are folds. Radio inputs and :has(), no script for the
 * chips; every block stays in the page for crawlers; a wider screen shows them all and no chips.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    // Media's published limits, so the page shows the limits table as it does in production.
    const t = await boot({
        mediaLimits: {
            get: async () => new Map([
                ['storage_bytes', { id: 'storage_bytes', label: 'Stored bytes', unit: 'bytes', production: 1024 ** 3, sandbox: 100 * 1024 ** 2 }],
            ]),
        },
    });
    await check('the home on a phone: the code samples are chips, the rest are folds', async () => {
        const r = await t.get('/');
        assert.strictEqual(r.status, 200);
        const text = r.text;

        // The code samples: one pick block, a chip per sample, the first one picked.
        assert.ok(text.includes('<div class="pick" id="pick-tools">'), 'the code samples are one pick block');
        assert.match(text, /<div class=\"ov-parts ov-parts--front\" data-parts=\"\d+\">/, 'its parts are tabs on a phone');
        const chips = [...text.matchAll(/<label for="ovp-[a-z0-9]+-(?:pp-tools-)?([a-z-]+)">()([^<]+)(?: <span class="ov-parts-n">[^<]*<\/span>)?<\/label>/g)];
        assert.deepStrictEqual(chips.map((m) => m[1]), ['aws-cli', 'rclone', 'node', 'sdk'], 'a chip per sample');
        assert.ok(/<input type=\"radio\" class=\"ov-parts-r\"[^>]* checked>/.test(text), 'the first part is open on a phone (Shared pick(): tabs, 11-12)');
        assert.strictEqual((text.match(/class="pick-pane"/g) || []).length, chips.length, 'one pane per chip');
        // Every sample stays in the page for the crawlers.
        for (const label of ['AWS CLI', 'rclone', 'Node (AWS SDK v3)', 'Manage zones (openvibe-sdk)']) {
            assert.ok(text.includes(`<figcaption>${label}</figcaption>`), `${label} is in the page`);
        }

        // The folds: open in the page, closed on a phone, and their content stays in the page.
        for (const id of ['zn-what', 'zn-limits', 'zn-faq', 'zn-shipped']) {
            assert.ok(text.includes(`<details class="zn-fold zn-fold-block" id="${id}" open>`), `${id} is a fold, open in the page`);
            assert.ok(text.includes(`document.getElementById("${id}")`), `${id} has the script that closes it on a phone`);
        }
        assert.ok(text.includes('Private by default.'), 'what a zone gives you is still in the page');
        assert.ok(text.includes('Which S3 operations work?'), 'the questions are still in the page');
        assert.ok(text.includes('ov-shipped-home'), 'what shipped is still in the page');

        const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');

        assert.match(css, /\.pick-pane \{ min-width: 0; \}/, 'a pane of wide code shrinks with its column (it widened the phone page to 861 px, 2026-11-01)');
        assert.match(css, /\.pick-row \{ display: none; \}/, 'the chips are hidden by default');
    });
    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
