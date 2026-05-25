# @remember-md/mcp

Local MCP server for the [Remember.md](https://github.com/remember-md/remember) second brain. Run via `npx`, point any MCP client at it, query your markdown brain semantically.

> **Status:** v0.1.0 — first functional release. One tool: `search_brain`. Active development continues.

## What it does

Exposes your local markdown brain (a folder of `.md` files organised PARA-style by the [Remember.md plugin](https://github.com/remember-md/remember)) as a set of MCP tools any MCP client can call — Claude Code, OpenClaw, Cursor, Codex CLI, Claude.ai web, ChatGPT custom GPTs, anything that speaks the Model Context Protocol.

Tools shipped in v0.1.0:

- `search_brain(query, top_k)` — hybrid retrieval. BM25 + vector + RRF fusion + 1-hop wikilink expansion. Lexical-first: BM25 results land immediately on first run, vector embeddings build in background and layer in once ready.

Tools planned for v0.2+:

- `get_file(path)` — read a brain file
- `list_recent(period, kind?)` — recent journal / notes / decisions
- `query_persona()` — current `Persona.md` content
- `dashboard_snapshot()` — counts + top beliefs + active projects
- `propose_belief(claim, evidence)` — write candidate to `Inbox/`

## How it works

- **Storage:** `node:sqlite` (Node 22.5+ stdlib) + [sqlite-vec](https://github.com/asg017/sqlite-vec) extension for vector search + FTS5 for BM25 — no server, no native compilation, no toolchain.
- **Embeddings:** [@huggingface/transformers](https://github.com/huggingface/transformers.js) running quantized `Xenova/all-MiniLM-L6-v2` (384d, ~23 MB) locally — no cloud calls.
- **Sync:** on-demand mtime + content-hash incremental reindex at query time. The brain (markdown) is the source of truth; the index in `.remember/index.db` is rebuildable.
- **Graceful degradation:** if vector loads fail, falls back to FTS5-only; if both fail, falls back to ripgrep.

## Install

You don't install it. Point your MCP client at it via `npx`:

### Claude Code (via the Remember.md plugin's `/remember:init`)

The [Remember.md plugin](https://github.com/remember-md/remember) automatically configures Claude Code's MCP layer to launch this server. Just run `/remember:init`.

### Cursor / Codex / other MCP clients

Add to your MCP config:

```json
{
  "mcpServers": {
    "remember": {
      "command": "npx",
      "args": ["-y", "@remember-md/mcp"],
      "env": {
        "REMEMBER_BRAIN_PATH": "/absolute/path/to/your/brain"
      }
    }
  }
}
```

First run downloads the package (~15–30s) and the embedding model (~23 MB, one-time). After that, queries are sub-second.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `REMEMBER_BRAIN_PATH` | `~/remember` | Brain root directory (folder of markdown files) |
| `REMEMBER_INDEX_DIR` | `${brain}/.remember` | Where the SQLite index lives |
| `REMEMBER_EMBEDDING_MODEL` | `Xenova/all-MiniLM-L6-v2` | Hugging Face model id |
| `REMEMBER_TIER` | auto | `auto` / `vec` / `fts5` / `ripgrep` (force a fallback tier) |

## Privacy

Local-only. No cloud calls. No telemetry. The brain folder + index never leave your machine. Embedding model runs in-process via ONNX Runtime.

## License

MIT — see [LICENSE](LICENSE).

## Related

- [Remember.md plugin](https://github.com/remember-md/remember) — the capture / curate / persona side that produces the brain this server queries
- [Remember.md spec](https://remember.md/spec) — the markdown standard
