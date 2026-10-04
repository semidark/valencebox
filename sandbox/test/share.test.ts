// Phase 3 verification: WebDAV share round-trip without a VM.
// Boots HttpShare against a temp dir and exercises auth, CRUD, and
// path-traversal rejection over plain HTTP.
import * as http from "http";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { HttpShare } from "../src/main/http-share";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

interface ReqResult {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

function req(
  port: number,
  method: string,
  urlPath: string,
  opts: { token?: string; username?: string; body?: string; headers?: Record<string, string> } = {}
): Promise<ReqResult> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(opts.headers || {}) };
    if (opts.token !== undefined) {
      const user = opts.username ?? "valence";
      headers["Authorization"] =
        "Basic " + Buffer.from(`${user}:${opts.token}`).toString("base64");
    }
    const r = http.request(
      { host: "127.0.0.1", port, method, path: urlPath, headers },
      (res) => {
        let body = "";
        res.setEncoding("utf-8");
        res.on("data", (c) => (body += c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers })
        );
      }
    );
    r.on("error", reject);
    if (opts.body !== undefined) r.write(opts.body);
    r.end();
  });
}

async function withShare(
  fn: (share: HttpShare, dir: string) => Promise<void>
): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vb-share-"));
  const share = new HttpShare();
  try {
    await share.start(dir);
    await fn(share, dir);
  } finally {
    await share.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---- Auth ----

async function testAuth() {
  await withShare(async (share, dir) => {
    fs.writeFileSync(path.join(dir, "seeded.txt"), "hello");

    const noAuth = await req(share.port, "PROPFIND", "/", {
      headers: { Depth: "1" },
    });
    assert(noAuth.status === 401, `unauthenticated PROPFIND -> 401 (got ${noAuth.status})`);
    assert(
      /WWW-Authenticate/i.test(JSON.stringify(noAuth.headers)),
      "401 carries WWW-Authenticate"
    );

    const wrongToken = await req(share.port, "PROPFIND", "/", {
      token: "deadbeef".repeat(4),
      headers: { Depth: "1" },
    });
    assert(wrongToken.status === 401, `wrong token -> 401 (got ${wrongToken.status})`);

    const wrongUser = await req(share.port, "PROPFIND", "/", {
      username: "mallory",
      token: share.token,
      headers: { Depth: "1" },
    });
    assert(wrongUser.status === 401, `wrong username -> 401 (got ${wrongUser.status})`);

    const ok = await req(share.port, "PROPFIND", "/", {
      token: share.token,
      headers: { Depth: "1" },
    });
    assert(ok.status === 207, `authenticated PROPFIND -> 207 (got ${ok.status})`);
    assert(ok.body.includes("seeded.txt"), "listing contains seeded file");
    console.log("✓ auth: 401 unauth/wrong-token/wrong-user, 207 with token");
  });
}

// ---- CRUD round-trip ----

async function testCrud() {
  await withShare(async (share, dir) => {
    const put = await req(share.port, "PUT", "/newfile.txt", {
      token: share.token,
      body: "synced content",
    });
    assert(put.status === 201, `PUT -> 201 (got ${put.status})`);
    assert(
      fs.existsSync(path.join(dir, "newfile.txt")),
      "PUT file exists on host disk"
    );
    assertEqFile(path.join(dir, "newfile.txt"), "synced content");

    const get = await req(share.port, "GET", "/newfile.txt", { token: share.token });
    assert(get.status === 200, `GET -> 200 (got ${get.status})`);
    assert(get.body === "synced content", "GET round-trips content");

    const mkdir = await req(share.port, "MKCOL", "/subdir", { token: share.token });
    assert(mkdir.status === 201, `MKCOL -> 201 (got ${mkdir.status})`);
    const nested = await req(share.port, "PUT", "/subdir/inner.txt", {
      token: share.token,
      body: "nested",
    });
    assert(nested.status === 201, `PUT nested -> 201 (got ${nested.status})`);
    assert(fs.existsSync(path.join(dir, "subdir", "inner.txt")), "nested file on disk");

    const del = await req(share.port, "DELETE", "/newfile.txt", { token: share.token });
    assert(del.status === 204 || del.status === 200, `DELETE -> 2xx (got ${del.status})`);
    assert(!fs.existsSync(path.join(dir, "newfile.txt")), "deleted file gone from disk");

    const anonPut = await req(share.port, "PUT", "/anon.txt", { body: "x" });
    assert(anonPut.status === 401, `unauthenticated PUT -> 401 (got ${anonPut.status})`);
    assert(!fs.existsSync(path.join(dir, "anon.txt")), "anon PUT did not write to disk");
    console.log("✓ CRUD: PUT/GET/MKCOL/DELETE round-trip; anon PUT rejected");
  });
}

function assertEqFile(p: string, expected: string): void {
  const actual = fs.readFileSync(p, "utf-8");
  if (actual !== expected) {
    throw new Error(`ASSERTION FAILED: file content — expected '${expected}', got '${actual}'`);
  }
}

// ---- Path traversal rejection ----

async function testTraversal() {
  await withShare(async (share, dir) => {
    const outside = path.join(path.dirname(dir), "vb-escape-target.txt");
    fs.rmSync(outside, { force: true });

    // Raw (unencoded) traversal must be rejected outright.
    for (const p of ["/../vb-escape-target.txt", "/subdir/../../vb-escape-target.txt"]) {
      const r = await req(share.port, "PUT", p, { token: share.token, body: "escaped" });
      assert(r.status >= 400, `raw traversal PUT ${p} rejected with 4xx (got ${r.status})`);
    }

    // Percent-encoded traversal: nephele decodes %2F/%2e%2e and CLAMPS the
    // path to the share root (observed: 201 with the file landing inside the
    // root). The security property that matters is that nothing is written
    // outside the root — assert that, regardless of status code.
    for (const p of [
      "/..%2Fvb-escape-target.txt",
      "/%2e%2e/vb-escape-target.txt",
      "/..%2f..%2fetc/passwd",
    ]) {
      await req(share.port, "PUT", p, { token: share.token, body: "escaped" });
    }
    assert(!fs.existsSync(outside), "no file written outside the share root");
    assert(!fs.existsSync(path.join(path.dirname(dir), "etc")), "no etc dir created outside root");

    const escapeGet = await req(share.port, "GET", "/../etc/passwd", {
      token: share.token,
    });
    assert(
      escapeGet.status >= 400,
      `traversal GET /../etc/passwd rejected (got ${escapeGet.status})`
    );
    assert(!escapeGet.body.includes("root:"), "traversal GET did not return passwd content");

    fs.rmSync(outside, { force: true });
    console.log("✓ traversal: raw escapes 4xx, encoded escapes clamped to root, nothing outside");
  });
}

// ---- Run all ----

async function main() {
  try {
    await testAuth();
    await testCrud();
    await testTraversal();
    console.log("\nALL SHARE TESTS PASSED");
  } catch (err: any) {
    console.error("\nTEST FAILED:", err.message);
    process.exit(1);
  }
}

main();
