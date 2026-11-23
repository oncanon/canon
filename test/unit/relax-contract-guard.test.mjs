// relaxEscapes contract guard (src/render/relax.mjs withinRelaxContract).
//
// relaxEscapes is sound only over the Markdown subset the generator emits. Any
// document containing a construct outside that subset must come back byte for byte.
// Each trigger is paired with a control document that differs only by the trigger and
// IS relaxed, so a pass proves the trigger (not an inert relaxer) kept the escapes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { relaxEscapes, withinRelaxContract } from '../../src/render/relax.mjs';

// "snake\_case" is relaxed by relaxEscapes in generated prose (intraword "_").
const BODY = 'Use snake\\_case here.';
const RELAXED_BODY = 'Use snake_case here.';

const TRIGGERS = [
  ['tab', `${BODY}\ta`, `${BODY} a`],
  ['vertical tab', `${BODY}\va`, `${BODY} a`],
  ['form feed', `${BODY}\fa`, `${BODY} a`],
  ['carriage return', `${BODY}\r`, `${BODY}`],
  ['NUL', `${BODY}\u0000`, `${BODY}`],
  ['DEL', `${BODY}\u007f`, `${BODY}`],
  ['NBSP', `${BODY}\u00a0a`, `${BODY} a`],
  ['en quad', `${BODY}\u2000a`, `${BODY} a`],
  ['line separator', `${BODY}\u2028a`, `${BODY} a`],
  ['ideographic space', `${BODY}\u3000a`, `${BODY} a`],
  ['backslash before carriage return', `${BODY}\\\r\\# Heading`, `${BODY}\\\\ \\# Heading`],
  ['backslash before NBSP', `${BODY}\\\u00a0\\# a`, `${BODY}\\\\ \\# a`],
  ['byte order mark', `\ufeff${BODY}`, `${BODY}`],
  ['next line (NEL)', `${BODY}\u0085a`, `${BODY} a`],
  ['C1 control', `${BODY}\u0080a`, `${BODY} a`],
  ['C1 control (last)', `${BODY}\u009fa`, `${BODY} a`],
  ['ogham space', `${BODY}\u1680a`, `${BODY} a`],
  ['narrow no-break space', `${BODY}\u202fa`, `${BODY} a`],
  ['footnote definition with an escaped bracket', `${BODY}\n\n[^a\\]]: note`, `${BODY}\n\n[^a\\]](https://x.example)`],
  ['raw HTML tag', `${BODY} <span>a</span>`, `${BODY} \\<span>a\\</span>`],
  ['raw autolink', `${BODY} <https://x.example>`, `${BODY} \\<https://x.example>`],
  ['footnote definition', `${BODY}\n\n[^n]: note`, `${BODY}\n\n[^n](https://x.example)`],
  ['unclosed code span', `${BODY} \`a`, `${BODY} \`a\``],
  ['unclosed fence', `${BODY}\n\n\`\`\`js\nx`, `${BODY}\n\n\`\`\`js\nx\n\`\`\``],
];

for (const [name, outside, control] of TRIGGERS) {
  test(`[E8] relax guard: ${name}: document outside the generated subset is returned unchanged`, () => {
    assert.equal(withinRelaxContract(outside), false, 'guard classifies the trigger as out of contract');
    assert.equal(relaxEscapes(outside), outside, 'escapes kept byte for byte');
    assert.equal(withinRelaxContract(control), true, 'control is within contract');
    assert.ok(relaxEscapes(control).startsWith(RELAXED_BODY), `control is relaxed: ${JSON.stringify(relaxEscapes(control))}`);
  });
}

test('[E8] relax guard: a code span closes only on a backtick run of equal length', () => {
  assert.equal(withinRelaxContract('`a``b` snake\\_case'), true, 'a longer run inside a span is content');
  assert.equal(withinRelaxContract('``a`b snake\\_case'), false, 'a shorter run does not close the span');
  assert.equal(withinRelaxContract('``a```b` snake\\_case'), false, 'a longer run does not close the span either');
});

test('[E8] relax guard: constructs the generator does emit stay within contract', () => {
  const generated = [
    '[^lt;\\>](https://example.org/p) and snake\\_case',
    '`<sha256>` and `` a`b `` with snake\\_case',
    '\\<span\\> is escaped, snake\\_case',
    '```typescript\nconst a = "<b>\\t";\t// tab and < inside a fence\n```\nsnake\\_case',
    '| a \\| b | c |\n| --- | ---: |\n| x | 1 |',
  ];
  for (const md of generated) assert.equal(withinRelaxContract(md), true, JSON.stringify(md));
});

test('[E8] relax guard: a fence is closed only by the identical fence line', () => {
  assert.equal(withinRelaxContract('```js\n```jsx\nsnake\\_case\n```'), true, 'a fence line with another info string is content');
  assert.equal(withinRelaxContract('````js\n```\n<b>\n````'), true, 'shorter run inside a longer fence is content');
  assert.equal(withinRelaxContract('```js\n````\n<b>'), false, 'a longer run does not close a generated fence');
});
