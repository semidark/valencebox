import {
  hostAllowed,
  generatePlaceholder,
  resolveSecrets,
  rewriteHeaders,
  rewriteBody,
  PlaceholderViolation,
  EgressProxy,
} from "../src/main/egress-proxy";
import { EgressRuntimeConfig, EgressConfig, ResolvedSecret } from "../src/config";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

function assertEq(actual: any, expected: any, msg: string): void {
  if (actual !== expected) {
    throw new Error(`ASSERTION FAILED: ${msg} — expected '${expected}', got '${actual}'`);
  }
}

function assertThrows(fn: () => void, msg: string): void {
  try {
    fn();
    throw new Error(`ASSERTION FAILED: ${msg} — expected an error to be thrown`);
  } catch (e: any) {
    if (e.message && e.message.startsWith("ASSERTION FAILED:")) throw e;
    // Expected error.
  }
}

// ---- hostAllowed ----

{
  // allowlist: exact match
  assert(hostAllowed("pypi.org", "allowlist", ["pypi.org"], []), "allowlist exact match");
  assert(!hostAllowed("example.com", "allowlist", ["pypi.org"], []), "allowlist non-match");
  console.log("✓ hostAllowed: allowlist exact match");
}

{
  // allowlist: wildcard subdomain
  assert(hostAllowed("files.pythonhosted.org", "allowlist", ["*.pythonhosted.org"], []), "allowlist wildcard subdomain");
  assert(hostAllowed("pythonhosted.org", "allowlist", ["*.pythonhosted.org"], []), "allowlist wildcard apex (starts with dot)");
  assert(!hostAllowed("evil.com", "allowlist", ["*.pythonhosted.org"], []), "allowlist wildcard non-match");
  console.log("✓ hostAllowed: allowlist wildcard");
}

{
  // denylist
  assert(hostAllowed("pypi.org", "denylist", [], ["evil.com"]), "denylist non-blocked");
  assert(!hostAllowed("evil.com", "denylist", [], ["evil.com"]), "denylist blocked exact");
  assert(!hostAllowed("sub.evil.com", "denylist", [], ["*.evil.com"]), "denylist blocked wildcard");
  console.log("✓ hostAllowed: denylist");
}

{
  // policy = none allows everything
  assert(hostAllowed("anything.com", "none", [], []), "none policy allows everything");
  assert(hostAllowed("also-anything.com", "none", ["some-host.com"], ["blocked.com"]), "none policy ignores allow/deny lists");
  console.log("✓ hostAllowed: none policy");
}

{
  // Deny takes priority over allow
  assert(!hostAllowed("pypi.org", "allowlist", ["pypi.org"], ["pypi.org"]), "deny takes priority over allow");
  console.log("✓ hostAllowed: deny priority");
}

{
  // Wildcard "*" matches everything
  assert(hostAllowed("anything.org", "allowlist", ["*"], []), "wildcard * matches everything");
  console.log("✓ hostAllowed: wildcard *");
}

{
  // Case insensitive
  assert(hostAllowed("PYPI.ORG", "allowlist", ["pypi.org"], []), "allowlist case insensitive");
  assert(hostAllowed("PyPi.Org", "allowlist", ["pypi.org"], []), "allowlist mixed case");
  assert(!hostAllowed("EVIL.COM", "allowlist", ["pypi.org"], []), "allowlist non-match case insensitive");
  console.log("✓ hostAllowed: case insensitive");
}

{
  // Trailing dot is stripped
  assert(hostAllowed("pypi.org.", "allowlist", ["pypi.org"], []), "allowlist trailing dot stripped");
  console.log("✓ hostAllowed: trailing dot");
}

{
  // Port stripped
  assert(hostAllowed("pypi.org:443", "allowlist", ["pypi.org"], []), "allowlist port stripped");
  assert(hostAllowed("pypi.org:9999", "allowlist", ["pypi.org"], []), "allowlist non-standard port stripped");
  console.log("✓ hostAllowed: port stripped");
}

// ---- generatePlaceholder ----

{
  const p1 = generatePlaceholder();
  const p2 = generatePlaceholder();
  assert(p1.startsWith("psbx-sec-"), "placeholder starts with psbx-sec-");
  assert(p1.length > 20, "placeholder has sufficient length");
  assert(p1 !== p2, "placeholders are unique");
  // Should be hex chars only after the prefix
  const hexPart = p1.slice(9);
  assert(/^[a-f0-9]+$/.test(hexPart), "placeholder hex part is hex");
  console.log("✓ generatePlaceholder");
}

// ---- resolveSecrets ----

{
  // fromEnv resolves correctly
  process.env.TEST_SECRET = "my-real-secret-value";
  const resolved = resolveSecrets([
    { env: "MY_SECRET", fromEnv: "TEST_SECRET", hosts: ["api.example.com"] },
  ]);
  assertEq(resolved.length, 1, "one resolved secret");
  assertEq(resolved[0].env, "MY_SECRET", "env name preserved");
  assertEq(resolved[0].value, "my-real-secret-value", "value from env");
  assert(resolved[0].placeholder.startsWith("psbx-sec-"), "placeholder generated");
  assertEq(resolved[0].hosts[0], "api.example.com", "hosts preserved");
  console.log("✓ resolveSecrets: fromEnv");
}

{
  // inline value takes priority
  process.env.TEST_SECRET2 = "should-not-be-used";
  const resolved = resolveSecrets([
    { env: "MY_SECRET2", value: "inline-value", fromEnv: "TEST_SECRET2", hosts: ["api.example.com"] },
  ]);
  assertEq(resolved[0].value, "inline-value", "inline value takes priority");
  console.log("✓ resolveSecrets: inline value priority");
}

{
  // missing fromEnv throws
  delete process.env.MISSING_VAR;
  assertThrows(() => {
    resolveSecrets([{ env: "MISSING", fromEnv: "MISSING_VAR", hosts: ["x.com"] }]);
  }, "missing fromEnv throws");
  console.log("✓ resolveSecrets: missing fromEnv throws");
}

{
  // no value or fromEnv throws
  assertThrows(() => {
    resolveSecrets([{ env: "NO_VAL", hosts: ["x.com"] }]);
  }, "missing both value and fromEnv throws");
  console.log("✓ resolveSecrets: no value/fromEnv throws");
}

// ---- rewriteHeaders ----

{
  const secrets: ResolvedSecret[] = [
    { env: "TOKEN", value: "real-token-value", placeholder: "psbx-sec-placeholder", hosts: ["api.github.com"] },
  ];

  const headers: [string, string][] = [
    ["Authorization", "Bearer psbx-sec-placeholder"],
    ["Content-Type", "application/json"],
  ];

  const rewritten = rewriteHeaders(headers, secrets, "api.github.com");
  assertEq(rewritten[0][1], "Bearer real-token-value", "placeholder replaced in header value");
  assertEq(rewritten[1][1], "application/json", "non-secret header unchanged");
  console.log("✓ rewriteHeaders: replaces placeholder");
}

{
  // Proxy-Authorization and Proxy-Connection headers are stripped
  const secrets: ResolvedSecret[] = [];
  const headers: [string, string][] = [
    ["Proxy-Authorization", "Basic dGVzdDp0ZXN0"],
    ["Proxy-Connection", "keep-alive"],
    ["Host", "example.com"],
  ];

  const rewritten = rewriteHeaders(headers, secrets, "example.com");
  for (const [name] of rewritten) {
    assert(name.toLowerCase() !== "proxy-authorization", "proxy-authorization stripped");
    assert(name.toLowerCase() !== "proxy-connection", "proxy-connection stripped");
  }
  assertEq(rewritten.length, 1, "only host header remains");
  console.log("✓ rewriteHeaders: strips proxy headers");
}

{
  // Unauthorized host throws
  const secrets: ResolvedSecret[] = [
    { env: "TOKEN", value: "real-token", placeholder: "psbx-sec-abc", hosts: ["api.github.com"] },
  ];

  assertThrows(() => {
    rewriteHeaders([["Authorization", "Bearer psbx-sec-abc"]], secrets, "evil.com");
  }, "placeholder on unauthorized host throws");
  console.log("✓ rewriteHeaders: unauthorized host throws");
}

{
  // Multiple secrets with same placeholder on different hosts
  const secrets: ResolvedSecret[] = [
    { env: "GIT", value: "git-token", placeholder: "psbx-sec-ghi", hosts: ["api.github.com"] },
  ];

  assertThrows(() => {
    rewriteHeaders([["X-Token", "psbx-sec-ghi"]], secrets, "other.com");
  }, "secret unauthorized for host");
  console.log("✓ rewriteHeaders: secret unauthorized for host");
}

// ---- rewriteBody ----

{
  const secrets: ResolvedSecret[] = [
    { env: "KEY", value: "real-key", placeholder: "psbx-sec-body-1", hosts: ["api.example.com"] },
  ];

  const body = Buffer.from('{"api_key": "psbx-sec-body-1"}', "utf-8");
  const rewritten = rewriteBody(body, secrets);
  assertEq(rewritten.toString("utf-8"), '{"api_key": "real-key"}', "placeholder replaced in body");
  console.log("✓ rewriteBody: replaces placeholder");
}

{
  // Body without placeholder is unchanged (same buffer reference)
  const secrets: ResolvedSecret[] = [
    { env: "KEY", value: "real-key", placeholder: "psbx-sec-body-2", hosts: ["api.example.com"] },
  ];

  const body = Buffer.from('{"status": "ok"}', "utf-8");
  const rewritten = rewriteBody(body, secrets);
  assert(rewritten === body, "body without placeholder returns same buffer");
  console.log("✓ rewriteBody: unchanged body returns same reference");
}

// ---- EgressRuntimeConfig structure ----
{
  // Verify the config interface matches expected shape
  const config: EgressRuntimeConfig = {
    policy: "allowlist",
    allowHosts: ["pypi.org"],
    denyHosts: [],
    allowPorts: [80, 443],
    allowAll: false,
    enableMitm: false,
    secrets: [],
    port: 0,
    authToken: "test-token",
  };
  assertEq(config.policy, "allowlist", "config allows allowlist");
  assertEq(config.allowHosts[0], "pypi.org", "config has allow hosts");
  assertEq(config.enableMitm, false, "MITM disabled");
  console.log("✓ EgressRuntimeConfig: structure valid");
}

console.log("ALL EGRESS PROXY TESTS PASSED");
