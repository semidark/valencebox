# Repo Notes

- This repo is a single Rust CLI binary in `src/main.rs`; there is no workspace, no tests, and no extra packages.
- The CLI is an interactive agent loop that talks to an OpenAI-compatible `POST /chat/completions` endpoint and exposes seven tools: `read`, `bash`, `edit`, `write`, `ls`, `find`, and `grep` (modeled after pi coding agent).

# Verified Commands

- Native host build: `cargo build --release`
- Native 32-bit musl build without Docker: `cargo build --release --target i686-unknown-linux-musl`
- Validated 32-bit TLS build path: `docker build --platform=linux/386 -t rust-agent-32bit .`
- Run the 32-bit image interactively: `docker run --rm -it --platform=linux/386 -e OPENAI_API_KEY=... -e OPENAI_BASE_URL=https://api.openai.com/v1 -e MODEL=gpt-4o rust-agent-32bit`
- Run against mounted local files so the file tools operate on your repo: `docker run --rm -it --platform=linux/386 -v "$PWD:/work" -w /work -e OPENAI_API_KEY=... -e OPENAI_BASE_URL=https://api.openai.com/v1 -e MODEL=gpt-4o rust-agent-32bit`

# Build Quirks

- `Cargo.toml` enables TLS by default via the local `tls` feature, which maps to `ureq/tls`; do not remove that unless you explicitly want HTTP-only behavior.
- Cross-compiling TLS from the x86_64 host to `i686-unknown-linux-musl` is not the validated path here; the working TLS path is building natively inside the `i386/alpine` Docker image.
- The Docker build intentionally compiles twice: first with a placeholder `src/main.rs` to cache dependencies, then again after copying the real `src/`. The `touch src/main.rs` in the second build is required so Docker does not reuse the placeholder binary.

# Runtime Expectations

- Required env var: `OPENAI_API_KEY`.
- Optional env vars: `OPENAI_BASE_URL` (defaults to `https://api.openai.com/v1`) and `MODEL` (defaults to `gpt-4o`).
- The binary also accepts `ANTHROPIC_API_KEY` as a fallback env var name, but the request format is OpenAI-compatible, not Anthropic.
- The tool implementations operate on the process working directory. If behavior looks wrong in Docker, check `-w` and bind mounts first.

# Code Constraints Worth Noticing

- A hardcoded system prompt tells the agent it is a root-capable Linux CLI in its own environment.
- `read` has optional `offset` (1-indexed) and `limit` params; output auto-truncates at 2000 lines or 50KB with a continuation hint showing the next offset.
- `bash` executes `bash -c` with an optional `timeout` in ms (default 120s); output is tail-truncated to 2000 lines and the full output is saved to a temp file whose path is reported.
- `edit` takes an `edits` array of `{oldText, newText}` objects applied sequentially to the same file snapshot. Each edit finds the first `oldText` via `String::find`.
- `write` creates or overwrites a file, auto-creating parent directories. Use `edit` for precise modifications.
- `ls` is non-recursive, sorted alphabetically, with `/` suffix for directories, and truncates at 2000 entries or 50KB.
- `find` uses `fd` if available, otherwise falls back to `find`; supports `name` glob, `type` filter (`f`/`d`), and `limit`.
- `grep` uses `rg` if available, otherwise falls back to `grep -r`; supports `pattern`, `maxContextLines`, `caseSensitive`, `regex` toggle, match line truncation at 500 chars, and `limit`.
- API failures are surfaced back into the chat loop as assistant text; a 401 from the remote API is a useful smoke test that HTTPS is working.
