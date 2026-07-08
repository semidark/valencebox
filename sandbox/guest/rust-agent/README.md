# rust-agent

A small interactive code-editing agent written in Rust.

It talks to an OpenAI-compatible `POST /chat/completions` API and gives the model seven file and shell tools in the current working directory (modeled after the pi coding agent):

- `read`
- `bash`
- `edit`
- `write`
- `ls`
- `find`
- `grep`

The implementation is intentionally lean and is validated to build and run as a 32-bit Alpine Linux container with TLS support.

## Requirements

- An OpenAI-compatible API endpoint
- An API key in `OPENAI_API_KEY`
- Docker if you want the validated 32-bit TLS build path

## Environment Variables

- `OPENAI_API_KEY` required
- `OPENAI_BASE_URL` optional, defaults to `https://api.openai.com/v1`
- `MODEL` optional, defaults to `gpt-4o`

The binary also accepts `ANTHROPIC_API_KEY` as a fallback env var name, but the wire format is still OpenAI-compatible.

## Build

Native host build:

```bash
cargo build --release
```

Native 32-bit musl build without Docker:

```bash
cargo build --release --target i686-unknown-linux-musl
```

Validated 32-bit TLS build using Docker:

```bash
docker build --platform=linux/386 -t rust-agent-32bit .
```

## Run

Run the Docker image interactively:

```bash
docker run --rm -it --platform=linux/386 \
  -e OPENAI_API_KEY=your_key \
  -e OPENAI_BASE_URL=https://api.openai.com/v1 \
  -e MODEL=gpt-4o \
  rust-agent-32bit
```

Run it against your current project so the file tools can see and edit your files:

```bash
docker run --rm -it --platform=linux/386 \
  -v "$PWD:/work" \
  -w /work \
  -e OPENAI_API_KEY=your_key \
  -e OPENAI_BASE_URL=https://api.openai.com/v1 \
  -e MODEL=gpt-4o \
  rust-agent-32bit
```

If you want a shell first:

```bash
docker run --rm -it --platform=linux/386 \
  -v "$PWD:/work" \
  -w /work \
  -e OPENAI_API_KEY=your_key \
  -e OPENAI_BASE_URL=https://api.openai.com/v1 \
  -e MODEL=gpt-4o \
  --entrypoint sh \
  rust-agent-32bit
```

Then inside the container:

```sh
/usr/local/bin/agent
```

## How It Works

The agent keeps a conversation history locally and sends it on each request.

When the model requests a tool call, the agent executes it locally and sends the result back as a tool response. It repeats until the model returns normal assistant text.

The seven tools are:

### `read`

Reads a file from the local filesystem. Supports optional `offset` (1-indexed) and `limit` parameters. Output auto-truncates at 2000 lines or 50 KB, showing a continuation hint with the next offset.

### `bash`

Executes a bash command via `bash -c`. Supports an optional `timeout` in milliseconds (default 120s). Output is tail-truncated to 2000 lines and the full output is saved to a temp file whose path is reported. On non-zero exit, the exit code is shown.

### `edit`

Edits a file using exact text replacements. Takes a `path` and an `edits` array of `{oldText, newText}` objects. All edits are applied sequentially to the same file snapshot. Each edit finds and replaces the first occurrence via `String::find`. This is the most precise way to modify files.

### `write`

Creates or overwrites a file. Automatically creates parent directories if needed. Prefer `edit` for precise modifications to existing files.

### `ls`

Lists directory contents non-recursively. Returns entries sorted alphabetically, with `/` suffix for directories. Includes dotfiles. Output is truncated at 2000 entries or 50 KB.

### `find`

Finds files or directories by name or glob pattern. Uses `fd` if available, otherwise falls back to `find`. Supports `name` glob, `type` filter (`f`/`d`), and `limit`.

### `grep`

Searches for a pattern in files. Uses `rg` (ripgrep) if available, otherwise falls back to `grep -r`. Supports `pattern`, `maxContextLines`, `caseSensitive`, `regex` toggle, match line truncation at 500 chars, and `limit`.

## Notes

- The agent operates on its process working directory. In Docker, that usually means you want `-v "$PWD:/work" -w /work`.
- A `401 Unauthorized` response from the remote API is a useful smoke test that HTTPS is working and the request reached the server.
- The validated 32-bit TLS path is the Docker build. Cross-compiling TLS from an x86_64 host to `i686-unknown-linux-musl` is not the validated path here.
