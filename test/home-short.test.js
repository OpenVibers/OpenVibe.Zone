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
        assert.match(text, /<div class="pick-row" role="radiogroup" aria-label="The tools that reach a zone">/);
        const chips = [...text.matchAll(/<input type="radio" name="pick-tools" id="pk-tools-([a-z-]+)" value="\1"( checked)?><label for="pk-tools-\1">([^<]+)<\/label>/g)];
        assert.deepStrictEqual(chips.map((m) => m[1]), ['aws-cli', 'rclone', 'node', 'sdk'], 'a chip per sample');
        assert.deepStrictEqual(chips.filter((m) => m[2]).map((m) => m[1]), ['aws-cli'], 'the first sample is picked');
        assert.strictEqual((text.match(/class="pick-pane"/g) || []).length, chips.length, 'one pane per chip');
        // Every sample stays in the page for the crawlers.
        for (const label of ['AWS CLI', 'rclone', 'Node (AWS SDK v3)', 'Manage zones (openvibe-sdk)']) {
            assert.ok(text.includes(`<figcaption>${label}</figcaption>`), `${label} is in the page`);
        }
        // The rule that shows the picked sample is written for this page.
        assert.ok(text.includes('.pick:has(#pk-tools-aws-cli:checked) #pp-tools-aws-cli{display:block}'), 'the picked sample shows');

        // The folds: open in the page, closed on a phone, and their content stays in the page.
        for (const id of ['zn-what', 'zn-limits', 'zn-faq', 'zn-shipped']) {
            assert.ok(text.includes(`<details class="zn-fold zn-fold-block" id="${id}" open>`), `${id} is a fold, open in the page`);
            assert.ok(text.includes(`document.getElementById("${id}")`), `${id} has the script that closes it on a phone`);
        }
        assert.ok(text.includes('Private by default.'), 'what a zone gives you is still in the page');
        assert.ok(text.includes('Which S3 operations work?'), 'the questions are still in the page');
        assert.ok(text.includes('ov-shipped-home'), 'what shipped is still in the page');

        // The CSS guard: the chips are hidden and the blocks all show until 640 px and where :has() is understood.
        const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
        assert.match(css, /\.pick-row \{ display: none; \}/, 'the chips are hidden by default');
        assert.match(css, /@supports selector\(:has\(\*\)\) \{ @media \(max-width: 640px\) \{/, 'the phone rules are under :has() and 640 px');
        assert.match(css, /\.pick-row label \{[^}]*min-height: 44px/, 'a chip is a 44 px target');
        assert.match(css, /\.pick-pane \{ display: none; \}/, 'the blocks are hidden on a phone');
    });
    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
