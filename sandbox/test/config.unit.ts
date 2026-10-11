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

console.log("ALL CONFIG VALIDATION TESTS PASSED");
