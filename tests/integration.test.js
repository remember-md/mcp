import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function setupBrain() {
  const root = mkdtempSync(join(tmpdir(), 'remember-mcp-it-'));
  mkdirSync(join(root, 'Notes'), { recursive: true });
  writeFileSync(
    join(root, 'Notes', 'postgres.md'),
    '# Postgres\n\nprefer postgres for projects with ACID needs.\n'
  );
  writeFileSync(
    join(root, 'Notes', 'react.md'),
    '# React\n\nUI library with hooks and components.\n'
  );
  return root;
}

function rpc(child, request) {
  return new Promise((resolve, reject) => {
    const id = request.id;
    let buf = '';
    let timer;
    function onData(chunk) {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) {
            child.stdout.off('data', onData);
            clearTimeout(timer);
            resolve(msg);
            return;
          }
        } catch {}
      }
    }
    child.stdout.on('data', onData);
    child.stdin.write(JSON.stringify(request) + '\n');
    timer = setTimeout(() => {
      child.stdout.off('data', onData);
      reject(new Error('rpc timeout'));
    }, 30000);
  });
}

test('integration: spawn server, list tools, call search_brain', async () => {
  const root = setupBrain();
  const child = spawn('node', ['src/index.js'], {
    env: {
      ...process.env,
      REMEMBER_BRAIN_PATH: root,
      // Use mock-friendly transformers? For v0.1.0 integration test we
      // accept BM25-only mode (vector_state will be 'embedding' or 'failed')
      // since we don't want to depend on real model download in CI.
      TRANSFORMERS_OFFLINE: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Drain stderr to avoid blocking.
  child.stderr.on('data', () => {});

  // 1. initialize
  const initRes = await rpc(child, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0' },
    },
  });
  assert.equal(initRes.result.serverInfo.name, '@remember-md/mcp');

  // 2. notifications/initialized
  child.stdin.write(JSON.stringify({
    jsonrpc: '2.0', method: 'notifications/initialized', params: {},
  }) + '\n');

  // 3. tools/list
  const tools = await rpc(child, {
    jsonrpc: '2.0', id: 2, method: 'tools/list', params: {},
  });
  assert.ok(tools.result.tools.some(t => t.name === 'search_brain'));

  // 4. tools/call search_brain
  const search = await rpc(child, {
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'search_brain', arguments: { query: 'postgres ACID', top_k: 3 } },
  });
  const payload = JSON.parse(search.result.content[0].text);
  assert.ok(Array.isArray(payload.results));
  assert.ok(payload.results.length > 0, 'expected at least one result');
  assert.match(payload.results[0].path, /postgres/);

  child.kill();
  rmSync(root, { recursive: true, force: true });
});
