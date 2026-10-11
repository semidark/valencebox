# Configuring the Sandbox — `sandbox.config.json`

The sandbox is configured with a single JSON file in the Electron user-data
directory. All keys are optional; anything absent falls back to the defaults
documented here.

- **Linux:** `~/.config/valencebox/sandbox.config.json`
- **macOS:** `~/Library/Application Support/valencebox/sandbox.config.json`
- **Windows:** `%APPDATA%\valencebox\sandbox.config.json`

> **The file must be strict JSON** — no comments, no trailing commas. The
> loader silently falls back to an empty config if parsing fails, so a syntax
> error silently restores defaults. Validate with `python3 -m json.tool
> sandbox.config.json` (or an editor) before saving.

Restart the app after changing the file — config is read at startup only.

## Full annotated example

```jsonc
{
  // ── VM ────────────────────────────────────────────────────────────────
  "guest": "x86_64",              // "x86_64" | "aarch64" (default: auto-select)
  "accel": "auto",                // "auto" | "kvm" | "hvf" | "whpx" | "tcg"
  "memMb": 4096,                  // guest RAM
  "smp": 2,                       // guest vCPUs
  "balloonMinMb": 2048,           // memory-balloon floor
  "workspaceDir": "~/src/project", // host dir served to the guest as /workspace
  "gpuEnabled": true,             // false disables Chromium GPU accel (broken GLX hosts)
  "swapCtrlCmd": false,           // macOS: swap physical Ctrl/Cmd for terminal control

  // ── Egress / networking ───────────────────────────────────────────────
  "egress": {
    "enforce": true,              // strict containment (default true on Linux)
    "policy": "allowlist",        // "allowlist" | "denylist" | "none"
    "allowHosts": ["pypi.org", "*.pythonhosted.org"],
    "denyHosts": [],
    "allowPorts": [80, 443],      // [] = any port
    "allowAll": false,            // bypass host filtering (policy only)
    "listenPort": 0,              // host proxy port; 0 = OS-assigned
    "listenHost": "127.0.0.1",    // strict mode defaults to 127.0.0.1
    "enableMitm": false,          // TLS interception for secret injection
    "maxConnections": 256,
    "rateLimitPerMin": 0,         // per client IP; 0 = unlimited
    "secrets": [                  // placeholders in the guest, real values host-side
      { "env": "GITHUB_TOKEN", "fromEnv": "GH_TOKEN_ON_HOST", "hosts": ["*.github.com"] }
    ],
    "caCertFile": "~/corp-ca-bundle.pem",   // PEM to verify UPSTREAM TLS against
    "guestCaFile": "/etc/pki/corp-root.pem",// PEM installed INTO the guest trust store
    "upstreamProxy": "http://proxy.corp.example:8080", // host-side chaining
    "upstreamNoProxy": "localhost, 127.0.0.0/8, ::1, .corp.example" // direct-dial exceptions
  },

  // ── Port forwarding (host → guest) ────────────────────────────────────
  "portForwards": [
    { "hostPort": 2223, "guestPort": 22, "label": "SSH debug access" },
    { "hostPort": 8080, "guestPort": 3000, "label": "dev server" }
  ]
}
```

## VM settings

| Key | Default | Notes |
|---|---|---|
| `guest` | auto | `x86_64` or `aarch64`. Auto-selects aarch64 only on Apple Silicon with ARM assets installed. |
| `accel` | `"auto"` | `kvm` (Linux), `hvf` (Apple Silicon), `whpx` (Windows); always falls back to `tcg,thread=multi`. On x86-64, hardware accel runs the `microvm` machine; TCG runs `pc`. |
| `memMb` / `smp` | 4096 / 2 | Guest RAM and vCPUs. |
| `balloonMinMb` | 2048 | The host may reclaim guest memory down to this floor. |
| `workspaceDir` | userData dir | Host directory served to the guest as `/workspace` (canonical side of the sync). `node_modules` and `.git` are never synced — run package managers inside the guest. |
| `gpuEnabled` | `true` | Set `false` on hosts with broken GLX (e.g. SSH-forwarded X) to silence GPU-process errors. |
| `swapCtrlCmd` | `false` | macOS terminal key handling. |

## Network mode: `egress.enforce`

- **`true` (default on Linux)** — strict containment: the VM boots with
  `-nic none`. There is no guest NIC, no SLIRP, **no UDP, no ICMP**. The only
  guest↔host path is the virtio-serial mux tunnel (see `docs/NET-CONTAINMENT.md`,
  protocol in `docs/mux-protocol.md`); all guest egress is forced through
  `EgressProxy`, where host policy applies. TCP port forwards are implemented
  as host listeners bridged over the tunnel.
- **`false`** — legacy SLIRP networking: unrestricted guest network; proxy
  environment variables steer cooperating clients only (they are not
  enforcement).
- On platforms where the tunnel is unverified (macOS, Windows), a requested
  strict mode falls back to legacy with a console warning — it never boots
  silently half-contained.
- **`protocol: "udp"` port forwards are rejected at startup in strict mode**
  (fail-closed). UDP forwards keep working only in legacy mode.

## Egress proxy

The proxy runs in the Electron main process. The guest reaches it through the
mux tunnel (`127.0.0.1:3128` relay in strict mode; `10.0.2.2:<port>` in legacy
mode). Requests must speak the standard proxy dialect — most tools do this via
`HTTP_PROXY`/`HTTPS_PROXY`, which the guest sets automatically.

| Key | Default | Notes |
|---|---|---|
| `policy` | `"none"` | `"allowlist"`: only `allowHosts` match. `"denylist"`: everything except `denyHosts`. `"none"`: no host filtering (the proxy still authenticates and enforces ports). |
| `allowHosts` / `denyHosts` | `[]` | Hostname patterns: `example.com`, `*.example.com`, `*`. `denyHosts` wins over `allowHosts`. |
| `allowPorts` | `[80, 443]` | Destination ports allowed through the proxy (CONNECT + plain HTTP). |
| `allowAll` | `false` | Skips host filtering only — ports, auth and rate limits still apply. |
| `listenPort` / `listenHost` | 0 / `127.0.0.1` in strict mode | Host-side TCP listener (for debugging; the guest does not use it in strict mode). Legacy mode defaults to `0.0.0.0`. |
| `maxConnections` / `rateLimitPerMin` | 256 / 0 | Concurrency cap and per-client-IP request rate (0 = unlimited). |
| `secrets` | `[]` | See below. |
| `enableMitm` | `false` | TLS interception on secret hosts for placeholder→secret rewriting. Experimental — see `HARDENING.md`. |
| `caCertFile` | — | PEM used to verify upstream TLS (internal CAs). Does not touch the guest. |
| `guestCaFile` | — | PEM installed **into the guest** trust store at boot (fw_cfg). Use for corporate TLS-inspection CAs — without it, HTTPS through an inspecting proxy fails certificate verification inside the guest. Takes precedence over the MITM CA for guest delivery. |
| `upstreamProxy` | — | `http://[user:pass@]host:port`. All EgressProxy upstream dials (CONNECT tunnels, plain HTTP, MITM re-encryption) go through this corporate proxy. Host/port policy is enforced **before** chaining. Only `http://` upstreams. |
| `upstreamNoProxy` | — | no_proxy-style exceptions: targets matching are dialed **directly** even when `upstreamProxy` is set. Comma/space-separated string or array: hostnames, `.suffix.domains`, IP literals, CIDR ranges (`10.0.0.0/8`, `fe80::/10`), or `*`. |

**Loopback is always direct** (`localhost`, `127.0.0.0/8`, `::1`) — it cannot
be routed through an external proxy and is not affected by this setting.

### Corporate network recipe (corporate networks)

```jsonc
{
  "egress": {
    "upstreamProxy": "http://proxy.corp.example:8080",
    "upstreamNoProxy": ".corp.example, .corp.internal, 10.0.0.0/8",
    "guestCaFile": "/etc/pki/ca-trust/source/anchors/CORP-ROOT-CA.crt"
  }
}
```

- External names (pypi, apt mirrors, …): guest → tunnel → EgressProxy →
  `proxy.corp.example` (with TLS inspection → `guestCaFile` makes the guest trust it).
- Internal hosts (`*.corp.example`, `*.corp.internal`, the `10.0.0.0/8` intranet):
  dialed **directly** from the host, bypassing the corp proxy.
- Note: package registries such as `registry.npmjs.org` may be blocked by
  corporate proxy policy itself (HTTP 403) — that is outside the sandbox's
  control; point package managers at the approved mirror instead.

### Secrets

Each secret is exposed to the guest as `ENV=<placeholder>`; the proxy replaces
the placeholder with the real value only on requests to matching `hosts`:

```jsonc
"secrets": [
  { "env": "GH_PAT", "fromEnv": "GH_PAT_ON_HOST", "hosts": ["*.github.com"] },
  { "env": "API_KEY", "fromFile": "~/secrets/api-key.txt", "hosts": ["api.internal"] },
  { "env": "TOKEN", "value": "inline-not-recommended", "hosts": ["*.example.com"] }
]
```

Prefer `fromEnv`/`fromFile` over `value` — inline values persist in the config
file. See `HARDENING.md` for the trust boundaries (placeholders are not a
compartment boundary; a root guest can always attempt to exfiltrate through
its own requests).

## Port forwards

Host → guest TCP forwards. In strict mode these are host listeners bridged
over the mux tunnel (the guest dials `127.0.0.1:<guestPort>`); in legacy mode
they are SLIRP `hostfwd` rules.

| Key | Default | Notes |
|---|---|---|
| `hostPort` / `guestPort` | required | 1–65535. |
| `hostIp` | `"127.0.0.1"` | Bind address for the host listener (`0.0.0.0` exposes to the network). |
| `protocol` | `"tcp"` | `"udp"` is **rejected in strict mode** (fail-closed). |
| `label` | — | Display/log label. |

Default when the key is absent:
`[{ "hostPort": 2222, "guestPort": 22, "label": "SSH debug access" }]`.
Set `[]` to disable all forwards. If another VM or service already owns the
host port, pick a different one (e.g. 2223):

```jsonc
{ "portForwards": [{ "hostPort": 2223, "guestPort": 22, "label": "SSH debug" }] }
```

SSH into the running VM with the baked-in debug key:

```sh
ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -i sandbox/images/vm-debug -p 2223 root@127.0.0.1
```

## Not configurable (fixed by design)

- Mux relay ports inside the guest: `3128` (egress proxy), `8081` (share).
- The WebDAV share token and proxy token are per-run random values.
- Snapshot save/restore is not implemented (`IPC.saveSnapshot` is a no-op).
