import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { FIXTURE } from '../helpers.mjs';
import { ENGINES, saveJson, setupPublished } from './setup.mjs';

let env;
test.before(async () => { env = await setupPublished(); });
test.after(() => env?.close());
const results = [];
test.after(() => saveJson('p11-code-copy.json', results));

for (const engine of ENGINES) {
  test(`[P11] ${engine.name}: selecting a code block copies exactly the source text (no line numbers, no doubled breaks)`, async () => {
    const report = JSON.parse(await readFile(FIXTURE, 'utf8'));
    const blocks = report.sections.flatMap((s) => s.blocks).filter((b) => b.type === 'code' || b.type === 'diff');
    const browser = await engine.type.launch();
    try {
      const page = await browser.newPage();
      await page.goto(env.packetUrl);
      for (const block of blocks) {
        const selected = await page.evaluate((id) => {
          const pre = document.querySelector(`#code-${id} pre`);
          const sel = getSelection();
          sel.selectAllChildren(pre);
          return sel.toString();
        }, block.id);
        const source = block.type === 'code' ? block.source : block.patch;
        // A single trailing newline at the end of a selection is engine behavior for
        // block-level selection and is not part of the copied lines.
        const normalized = selected.replace(/\n$/, '');
        results.push({ engine: engine.name, block: block.id, lines: source.split('\n').length, selectedLines: normalized.split('\n').length, exact: normalized === source, trailingNewline: selected.endsWith('\n') });
        assert.equal(normalized, source, `${engine.name} ${block.id}`);
      }
    } finally {
      await browser.close();
    }
  });
}
