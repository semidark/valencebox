// Config validation unit tests: strict-mode fail-closed rules and upstream
// proxy parsing. Part of test:unit.
import { validateNetworkConfig, parseUpstreamProxy, SandboxAppConfig } from "../src/config";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

function assertThrows(fn: () => void, match: string, msg: string): void {
  try {
    fn();
  } catch (err: any) {
    assert(err.message.includes(match), `${msg}: expected error containing '${match}', got '${err.message}'`);
    return;
  }
  throw new Error(`ASSERTION FAILED: ${msg}: expected throw`);
}

// Default (no config) is strict — UDP forwards must be rejected.
assertThrows(
  () => validateNetworkConfig({ portForwards: [{ hostPort: 5353, guestPort: 53, protocol: "udp" }] }),
  'protocol: "udp"',
  "udp forward rejected by default",
);

// TCP forwards are fine in strict mode.
validateNetworkConfig({ portForwards: [{ hostPort: 2222, guestPort: 22 }] });
validateNetworkConfig({ portForwards: [] });
validateNetworkConfig({});

// Legacy opt-out accepts UDP forwards.
validateNetworkConfig({
  egress: { enforce: false },
  portForwards: [{ hostPort: 5353, guestPort: 53, protocol: "udp" }],
});

// Mixed list: one UDP entry fails the whole config (fail-closed).
assertThrows(
  () => validateNetworkConfig({
    egress: { enforce: true },
    portForwards: [
      { hostPort: 2222, guestPort: 22 },
      { hostPort: 5353, guestPort: 53, protocol: "udp" },
    ],
  }),
  "hostPort 5353",
  "mixed list rejected",
);

// Explicit enforce: true behaves like the default.
assertThrows(
  () => validateNetworkConfig({
    egress: { enforce: true },
    portForwards: [{ hostPort: 53, guestPort: 53, protocol: "udp" }],
  }),
  'protocol: "udp"',
  "explicit strict rejects udp",
);

// upstreamProxy parsing: valid URL with credentials.
const up = parseUpstreamProxy("http://user:p%40ss@proxy.corp.example:8080");
assert(up.host === "proxy.corp.example", "upstream host parsed");
assert(up.port === 8080, "upstream port parsed");
assert(up.authHeader === "Basic " + Buffer.from("user:p@ss").toString("base64"), "upstream basic auth header");

// Defaults: no port → 80, no creds → no auth header.
const up2 = parseUpstreamProxy("http://proxy.corp.example");
assert(up2.port === 80 && up2.authHeader === undefined, "upstream defaults");

// Invalid URLs throw.
assertThrows(() => parseUpstreamProxy("https://proxy.corp.example"), "http://", "https upstream rejected");
assertThrows(() => parseUpstreamProxy("not a url"), "invalid URL", "garbage upstream rejected");
assertThrows(() => parseUpstreamProxy("http://"), "egress.upstreamProxy", "hostless upstream rejected");

// validateNetworkConfig parses upstreamProxy eagerly.
validateNetworkConfig({ egress: { upstreamProxy: "http://proxy.corp.example:3128" } });
assertThrows(
  () => validateNetworkConfig({ egress: { upstreamProxy: "socks5://proxy:1080" } }),
  "http://",
  "socks upstream rejected at config load",
);

// ---- upstreamNoProxy: parsing + matching ----
import { parseUpstreamNoProxy, matchesUpstreamNoProxy, UPSTREAM_NO_PROXY_LOOPBACK } from "../src/config";

// Malformed entries fail at config load.
assertThrows(
  () => validateNetworkConfig({ egress: { upstreamNoProxy: "10.0.0.0/64" } }),
  "exceeds /32",
  "bad v4 CIDR rejected",
);
assertThrows(
  () => validateNetworkConfig({ egress: { upstreamNoProxy: "not a host!" } }),
  "invalid host entry",
  "garbage host rejected",
);
validateNetworkConfig({ egress: { upstreamNoProxy: "localhost, .corp.example ,10.0.0.0/8, ::1" } });
validateNetworkConfig({ egress: { upstreamNoProxy: ["web.internal", "192.168.0.0/16"] } });

const np = parseUpstreamNoProxy("localhost, .corp.example , 192.168.10.28, 127.0.0.0/8, fe80::/10");
// Domain suffix semantics: .corp.example matches subdomains AND the bare domain.
assert(matchesUpstreamNoProxy("svc.corp.example", np), "suffix subdomain match");
assert(matchesUpstreamNoProxy("corp.example", np), "suffix bare-domain match");
assert(matchesUpstreamNoProxy("CORP.EXAMPLE:8080", np), "case+port insensitive");
assert(!matchesUpstreamNoProxy("notcorp.example", np), "suffix is dot-anchored");
// Hostname entries match the host and its subdomains.
const np2 = parseUpstreamNoProxy("registry.internal");
assert(matchesUpstreamNoProxy("registry.internal", np2), "exact hostname");
assert(matchesUpstreamNoProxy("mirror.registry.internal", np2), "hostname subdomain");
// IP literals and CIDRs (v4 + v6), brackets and ports tolerated.
assert(matchesUpstreamNoProxy("192.168.10.28", np), "ip literal");
assert(matchesUpstreamNoProxy("127.200.1.2", np), "v4 cidr in range");
assert(!matchesUpstreamNoProxy("128.0.0.1", np), "v4 cidr out of range");
assert(matchesUpstreamNoProxy("fe80::1234", np), "v6 cidr in range");
assert(!matchesUpstreamNoProxy("fec0::1", np), "v6 cidr out of range");
assert(matchesUpstreamNoProxy("[::1]:8081", parseUpstreamNoProxy("::1")), "bracketed v6 with port");
// Loopback default is always direct.
const loopback = parseUpstreamNoProxy(UPSTREAM_NO_PROXY_LOOPBACK);
assert(matchesUpstreamNoProxy("localhost", loopback), "loopback default: localhost");
assert(matchesUpstreamNoProxy("127.0.0.1", loopback), "loopback default: 127.0.0.1");
assert(matchesUpstreamNoProxy("[::1]", loopback), "loopback default: ::1");
assert(!matchesUpstreamNoProxy("example.com", loopback), "loopback default: external not matched");
// Wildcard bypasses everything.
assert(matchesUpstreamNoProxy("anything.example", parseUpstreamNoProxy("*")), "wildcard matches all");

console.log("ALL CONFIG VALIDATION TESTS PASSED");
