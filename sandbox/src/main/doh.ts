// Local DNS gate for the sandbox.
//
// v86's wisp network adapter resolves guest DNS by POSTing the raw DNS
// message to `https://<doh_server>/dns-query` using the *host process's*
// global fetch, and then opens wisp streams by resolved IP (never by name).
// So the egress policy is enforced in two coupled layers:
//   1. this DoH gate: only allowlisted hostnames resolve (else NXDOMAIN)
//   2. the wisp server: only IPs this gate answered ("pinned") are
//      connectable, on allowlisted ports
// Granularity note: a pinned CDN IP may serve other hostnames too — this is
// inherent to IP-level egress control.
import * as dns from "dns/promises";

export const DOH_GATE_HOST = "doh.sandbox.internal";

export interface DohGateOptions {
  hostAllowed: (name: string) => boolean;
  onResolve: (host: string, ip: string) => void;
  log?: (msg: string) => void;
}

// ---- minimal DNS wire format ----

function parseQuestion(msg: Buffer): { id: number; name: string; qtype: number } | null {
  if (msg.length < 17) return null;
  const id = msg.readUInt16BE(0);
  const qdcount = msg.readUInt16BE(4);
  if (qdcount < 1) return null;
  let off = 12;
  const labels: string[] = [];
  for (;;) {
    if (off >= msg.length) return null;
    const len = msg[off];
    if (len === 0) {
      off++;
      break;
    }
    if (len > 63 || off + 1 + len > msg.length) return null;
    labels.push(msg.subarray(off + 1, off + 1 + len).toString("latin1"));
    off += 1 + len;
  }
  if (off + 4 > msg.length) return null;
  const qtype = msg.readUInt16BE(off);
  return { id, name: labels.join("."), qtype };
}

function buildResponse(query: Buffer, opts: { rcode: number; ips?: string[] }): Buffer {
  const q = parseQuestion(query)!;
  // copy the full question section from the query
  let qEnd = 12;
  while (query[qEnd] !== 0) qEnd += query[qEnd] + 1;
  qEnd += 5; // zero byte + qtype + qclass
  const question = query.subarray(12, qEnd);

  const answers = (opts.ips ?? []).map((ip) => {
    const rr = Buffer.alloc(16);
    rr.writeUInt16BE(0xc00c, 0); // name: pointer to question
    rr.writeUInt16BE(1, 2); // TYPE A
    rr.writeUInt16BE(1, 4); // CLASS IN
    rr.writeUInt32BE(30, 6); // TTL 30s (keep pinning fresh)
    rr.writeUInt16BE(4, 10);
    const parts = ip.split(".").map((x) => parseInt(x, 10));
    rr[12] = parts[0];
    rr[13] = parts[1];
    rr[14] = parts[2];
    rr[15] = parts[3];
    return rr;
  });

  const hdr = Buffer.alloc(12);
  hdr.writeUInt16BE(q.id, 0);
  hdr.writeUInt16BE(0x8180 | (opts.rcode & 0xf), 2); // QR|RD|RA + rcode
  hdr.writeUInt16BE(1, 4); // QDCOUNT
  hdr.writeUInt16BE(answers.length, 6); // ANCOUNT
  return Buffer.concat([hdr, question, ...answers]);
}

async function answer(query: Buffer, opts: DohGateOptions): Promise<Buffer> {
  const q = parseQuestion(query);
  if (!q) return buildResponse(query, { rcode: 1 }); // FORMERR-ish
  const name = q.name.toLowerCase();

  if (!opts.hostAllowed(name)) {
    opts.log?.(`dns DENY ${name}`);
    return buildResponse(query, { rcode: 3 }); // NXDOMAIN
  }
  if (q.qtype !== 1) {
    // only A records are served (no AAAA → forces IPv4 path we control)
    return buildResponse(query, { rcode: 0, ips: [] });
  }
  try {
    const res = await dns.lookup(name, { family: 4, all: true });
    const ips = res.map((r) => r.address).slice(0, 4);
    for (const ip of ips) opts.onResolve(name, ip);
    opts.log?.(`dns ALLOW ${name} → ${ips.join(",")}`);
    return buildResponse(query, { rcode: 0, ips });
  } catch {
    return buildResponse(query, { rcode: 2 }); // SERVFAIL
  }
}

let installed = false;

/**
 * Patch global fetch so v86's DoH requests to DOH_GATE_HOST are answered
 * in-process. All other fetches pass through untouched.
 */
export function installDohGate(opts: DohGateOptions): string {
  if (installed) return DOH_GATE_HOST;
  installed = true;
  const realFetch = globalThis.fetch.bind(globalThis);
  (globalThis as any).fetch = async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    if (url.includes(DOH_GATE_HOST)) {
      const body: Uint8Array = init?.body;
      const resp = await answer(Buffer.from(body), opts);
      return new Response(new Uint8Array(resp), {
        status: 200,
        headers: { "content-type": "application/dns-message" },
      });
    }
    return realFetch(input, init);
  };
  return DOH_GATE_HOST;
}
