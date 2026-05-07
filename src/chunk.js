// Pure markdown chunker. Heading-aware (H1/H2/H3) split with recursive
// paragraph-boundary fallback when a section is too long. Each chunk's
// indexed text has the full heading path prepended ("contextual retrieval"
// pattern). YAML frontmatter is stripped. Code fences are honored so that
// `## ...` inside fenced blocks isn't treated as a heading.
//
// Token approximation: 1 token ≈ 0.75 words. Default cap 400 tokens
// (~300 words) per chunk. 15% overlap when recursive splitting kicks in.

const HEADING_RE = /^(#{1,3})\s+(.+?)\s*$/;
const FENCE_RE = /^```/;
const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n?/;

const APPROX_TOKENS_PER_WORD = 1 / 0.75;

function approxTokens(text) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.ceil(words * APPROX_TOKENS_PER_WORD);
}

function basenameNoExt(p) {
  const base = p.split('/').pop() || p;
  return base.replace(/\.md$/i, '');
}

function stripFrontmatter(body) {
  return body.replace(FRONTMATTER_RE, '');
}

// Walk lines, return [{ heading_path, body }] in order. Code-fenced regions
// are passed through verbatim and never trigger heading parsing.
function sectionize(body, fileTitle) {
  const lines = body.split('\n');
  const stack = []; // [H1, H2, H3]
  let inFence = false;
  let buf = [];
  const out = [];

  const currentPath = () => {
    const parts = stack.filter(Boolean);
    return parts.length === 0 ? fileTitle : parts.join(' > ');
  };
  const flush = () => {
    const text = buf.join('\n').trim();
    if (text) out.push({ heading_path: currentPath(), body: text });
    buf = [];
  };

  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      buf.push(line);
      continue;
    }
    if (inFence) {
      buf.push(line);
      continue;
    }
    const m = HEADING_RE.exec(line);
    if (m) {
      flush();
      const level = m[1].length;
      stack.length = level - 1;
      stack[level - 1] = m[2];
      continue;
    }
    buf.push(line);
  }
  flush();
  return out;
}

function recursiveSplit(text, maxTokens) {
  if (approxTokens(text) <= maxTokens) return [text];
  const paragraphs = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  if (paragraphs.length <= 1) {
    // Single paragraph too big; word-split as last resort with overlap.
    const words = text.split(/\s+/).filter(Boolean);
    const wordsPerChunk = Math.max(1, Math.floor(maxTokens / APPROX_TOKENS_PER_WORD));
    const overlap = Math.floor(wordsPerChunk * 0.15);
    const stride = Math.max(1, wordsPerChunk - overlap);
    const out = [];
    for (let i = 0; i < words.length; i += stride) {
      out.push(words.slice(i, i + wordsPerChunk).join(' '));
      if (i + wordsPerChunk >= words.length) break;
    }
    return out;
  }
  // Pack paragraphs greedily up to maxTokens, with 15% overlap by carrying
  // the trailing paragraph(s) into the next chunk.
  const out = [];
  let curr = [];
  let currTokens = 0;
  for (const p of paragraphs) {
    const t = approxTokens(p);
    if (currTokens + t > maxTokens && curr.length > 0) {
      out.push(curr.join('\n\n'));
      const targetOverlap = Math.ceil(currTokens * 0.15);
      const overlapBuf = [];
      let overlapTokens = 0;
      for (let i = curr.length - 1; i >= 0 && overlapTokens < targetOverlap; i--) {
        overlapBuf.unshift(curr[i]);
        overlapTokens += approxTokens(curr[i]);
      }
      curr = overlapBuf;
      currTokens = overlapTokens;
    }
    curr.push(p);
    currTokens += t;
  }
  if (curr.length) out.push(curr.join('\n\n'));
  return out;
}

export function chunkMarkdown({ path, body, maxTokens = 400 }) {
  if (!body || !body.trim()) return [];
  const cleaned = stripFrontmatter(body);
  const fileTitle = basenameNoExt(path);
  const sections = sectionize(cleaned, fileTitle);
  const out = [];
  for (const s of sections) {
    const pieces = recursiveSplit(s.body, maxTokens);
    for (const piece of pieces) {
      out.push({
        path,
        heading_path: s.heading_path,
        text: `${s.heading_path}\n${piece}`,
      });
    }
  }
  return out;
}
