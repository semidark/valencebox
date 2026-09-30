import {
  hostAllowed,
  generatePlaceholder,
  resolveSecrets,
  rewriteHeaders,
  rewriteBody,
  normalizeHost,
  sanitizeResponseHeaders,
  PlaceholderViolation,
  EgressProxy,
} from "../src/main/egress-proxy";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
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

{
  // Invalid env_name is rejected
  assertThrows(() => {
    resolveSecrets([{ env: "MY_SECRET'; rm -rf /; echo '", fromEnv: "TEST_SECRET", hosts: ["x.com"] }]);
  }, "env_name with shell metacharacters throws");
  assertThrows(() => {
    resolveSecrets([{ env: "123invalid", fromEnv: "TEST_SECRET", hosts: ["x.com"] }]);
  }, "env_name starting with digit throws");
  assertThrows(() => {
    resolveSecrets([{ env: "has space", fromEnv: "TEST_SECRET", hosts: ["x.com"] }]);
  }, "env_name with space throws");
  // Valid env_name is accepted
  const valid = resolveSecrets([{ env: "MY_SECRET_2", value: "val", hosts: ["x.com"] }]);
  assertEq(valid[0].env, "MY_SECRET_2", "valid env_name accepted");
  console.log("✓ resolveSecrets: invalid env_name rejected");
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
  // no value, fromFile, or fromEnv throws
  assertThrows(() => {
    resolveSecrets([{ env: "NO_VAL", hosts: ["x.com"] }]);
  }, "missing value, fromFile, and fromEnv throws");
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

// ---- resolveSecrets: fromFile ----

{
  // fromFile reads correctly
  const tmpFile = "/tmp/test-secret-" + Math.random().toString(36).slice(2);
  try {
    fs.writeFileSync(tmpFile, "file-secret-value\n", "utf-8");
    const resolved = resolveSecrets([
      { env: "FROM_FILE", fromFile: tmpFile, hosts: ["api.example.com"] },
    ]);
    assertEq(resolved.length, 1, "one resolved secret from file");
    assertEq(resolved[0].env, "FROM_FILE", "env name preserved (fromFile)");
    assertEq(resolved[0].value, "file-secret-value", "value from file (trailing newline stripped)");
    assert(resolved[0].placeholder.startsWith("psbx-sec-"), "placeholder generated (fromFile)");
    assertEq(resolved[0].hosts[0], "api.example.com", "hosts preserved (fromFile)");
    console.log("✓ resolveSecrets: fromFile");
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

{
  // fromFile with ~ expansion
  const home = os.homedir();
  const tmpFile = path.join(home, ".test-secret-" + Math.random().toString(36).slice(2));
  try {
    fs.writeFileSync(tmpFile, "tilde-expanded", "utf-8");
    const tildePath = "~/" + path.basename(tmpFile);
    const resolved = resolveSecrets([
      { env: "TILDE", fromFile: tildePath, hosts: ["x.com"] },
    ]);
    assertEq(resolved[0].value, "tilde-expanded", "~ expanded to homedir");
    console.log("✓ resolveSecrets: fromFile with ~ expansion");
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

{
  // fromFile missing throws
  assertThrows(() => {
    resolveSecrets([{ env: "MISSING_FILE", fromFile: "/tmp/nonexistent-" + Math.random().toString(36).slice(2), hosts: ["x.com"] }]);
  }, "missing fromFile throws");
  console.log("✓ resolveSecrets: fromFile missing throws");
}

{
  // fromFile empty throws
  const tmpFile = "/tmp/test-empty-" + Math.random().toString(36).slice(2);
  try {
    fs.writeFileSync(tmpFile, "", "utf-8");
    assertThrows(() => {
      resolveSecrets([{ env: "EMPTY_FILE", fromFile: tmpFile, hosts: ["x.com"] }]);
    }, "empty fromFile throws");
    console.log("✓ resolveSecrets: fromFile empty throws");
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

{
  // fromFile takes priority over fromEnv
  process.env.SHOULD_NOT_BE_USED = "env-value";
  const tmpFile = "/tmp/test-priority-" + Math.random().toString(36).slice(2);
  try {
    fs.writeFileSync(tmpFile, "file-value", "utf-8");
    const resolved = resolveSecrets([
      { env: "PRIORITY", fromFile: tmpFile, fromEnv: "SHOULD_NOT_BE_USED", hosts: ["x.com"] },
    ]);
    assertEq(resolved[0].value, "file-value", "fromFile takes priority over fromEnv");
    console.log("✓ resolveSecrets: fromFile priority over fromEnv");
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

// ---- normalizeHost ----

{
  // IPv4 with port is stripped
  assertEq(normalizeHost("example.com:8080"), "example.com", "IPv4 port stripped");
  // IPv4 without port is unchanged
  assertEq(normalizeHost("example.com"), "example.com", "IPv4 without port unchanged");
  // IPv6 bracketed with port
  assertEq(normalizeHost("[::1]:443"), "[::1]", "IPv6 bracketed port stripped");
  // IPv6 bare (no port) is preserved
  assertEq(normalizeHost("::1"), "::1", "IPv6 bare preserved");
  // IPv6 bare with zone ID (no port)
  assertEq(normalizeHost("fe80::1%eth0"), "fe80::1%eth0", "IPv6 with zone ID preserved");
  // Trailing dot stripped
  assertEq(normalizeHost("example.com."), "example.com", "trailing dot stripped");
  console.log("✓ normalizeHost");
}

// ---- sanitizeResponseHeaders ----

{
  const headers = {
    "content-type": "text/html",
    "strict-transport-security": "max-age=31536000; includeSubDomains",
    "public-key-pins": "pin-sha256=\"abc\"",
    "expect-ct": "max-age=1",
    "x-kept": "yes",
  };
  const out = sanitizeResponseHeaders(headers);
  assertEq(out["content-type"], "text/html", "content-type kept");
  assertEq(out["x-kept"], "yes", "unrelated header kept");
  assert(out["strict-transport-security"] === undefined, "HSTS stripped");
  assert(out["public-key-pins"] === undefined, "HPKP stripped");
  assert(out["expect-ct"] === undefined, "Expect-CT stripped");
  console.log("✓ sanitizeResponseHeaders: strips HSTS/HPKP/Expect-CT");
}

{
  // Case-insensitive stripping + report-only variant
  const headers = {
    "Strict-Transport-Security": "max-age=1",
    "Public-Key-Pins-Report-Only": "pin-x",
    "Content-Length": "5",
  };
  const out = sanitizeResponseHeaders(headers);
  assert(out["Strict-Transport-Security"] === undefined, "HSTS stripped case-insensitively");
  assert(out["Public-Key-Pins-Report-Only"] === undefined, "HPKP report-only stripped");
  assertEq(out["Content-Length"], "5", "content-length kept");
  console.log("✓ sanitizeResponseHeaders: case-insensitive + report-only");
}

{
  // Input not mutated
  const headers = { "strict-transport-security": "x" };
  sanitizeResponseHeaders(headers);
  assertEq(headers["strict-transport-security"], "x", "input object not mutated");
  console.log("✓ sanitizeResponseHeaders: input not mutated");
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
