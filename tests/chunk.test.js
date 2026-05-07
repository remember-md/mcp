import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkMarkdown } from '../src/chunk.js';

test('chunkMarkdown: single heading section', () => {
  const out = chunkMarkdown({
    path: 'Notes/foo.md',
    body: '# Foo\n\nbody one.\n\nbody two.\n',
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].path, 'Notes/foo.md');
  assert.equal(out[0].heading_path, 'Foo');
  assert.match(out[0].text, /^Foo\n/); // heading path prepended
  assert.match(out[0].text, /body one/);
  assert.match(out[0].text, /body two/);
});

test('chunkMarkdown: multiple H2 sections become separate chunks', () => {
  const body = `# Title\n\nintro.\n\n## Section A\n\na content.\n\n## Section B\n\nb content.\n`;
  const out = chunkMarkdown({ path: 'x.md', body });
  // 1 chunk for intro under # Title, 1 for ## Section A, 1 for ## Section B
  assert.equal(out.length, 3);
  assert.equal(out[0].heading_path, 'Title');
  assert.equal(out[1].heading_path, 'Title > Section A');
  assert.equal(out[2].heading_path, 'Title > Section B');
});

test('chunkMarkdown: deeply nested headings preserve full path', () => {
  const body = `# A\n\n## B\n\n### C\n\nleaf content.\n`;
  const out = chunkMarkdown({ path: 'x.md', body });
  const leaf = out.find(c => c.text.includes('leaf content'));
  assert.ok(leaf);
  assert.equal(leaf.heading_path, 'A > B > C');
});

test('chunkMarkdown: long sections split recursively at paragraph boundaries', () => {
  const huge = Array.from({ length: 50 }, (_, i) => `paragraph ${i}.`).join('\n\n');
  const body = `# Big\n\n${huge}\n`;
  const out = chunkMarkdown({ path: 'x.md', body, maxTokens: 100 });
  assert.ok(out.length > 1, 'should split into multiple chunks');
  for (const c of out) {
    assert.equal(c.heading_path, 'Big');
    // each chunk has the heading prepended
    assert.match(c.text, /^Big\n/);
  }
});

test('chunkMarkdown: skips YAML frontmatter at top of file', () => {
  const body = `---\ncreated: 2026-05-07\n---\n\n# Real Title\n\nbody.\n`;
  const out = chunkMarkdown({ path: 'x.md', body });
  assert.equal(out.length, 1);
  assert.equal(out[0].heading_path, 'Real Title');
  assert.doesNotMatch(out[0].text, /created:/);
});

test('chunkMarkdown: file with no headings uses filename as heading', () => {
  const out = chunkMarkdown({
    path: 'Notes/loose-note.md',
    body: 'just some body text without any heading.\n',
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].heading_path, 'loose-note');
  assert.match(out[0].text, /just some body/);
});

test('chunkMarkdown: empty body returns empty array', () => {
  const out = chunkMarkdown({ path: 'x.md', body: '' });
  assert.deepEqual(out, []);
});

test('chunkMarkdown: code fences are not parsed as headings', () => {
  const body = `# Real\n\nintro.\n\n\`\`\`md\n## Not a heading\n\`\`\`\n\nmore.\n`;
  const out = chunkMarkdown({ path: 'x.md', body });
  assert.equal(out.length, 1, 'should be one chunk; code-fenced ## is not a heading');
  assert.equal(out[0].heading_path, 'Real');
});
