import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";

/**
 * PLAN.md §32.1 (review concern 19) — the single shared outbound HTTP
 * dispatcher for every tenant-supplied URL in the platform (`trigger_webhook`
 * here in PR1; `webhook-delivery.ts` in PR2 once its retry mechanism is
 * being touched anyway). Threat model: a compromised/malicious tenant admin
 * configuring a URL, not an anonymous external attacker — the point is that
 * tenant admins are trusted with their own business's config, never with
 * reaching Ziyrak's own internal network or cloud metadata endpoint.
 *
 * A literal hostname-string denylist (the first-pass mitigation this
 * replaces) is bypassable via a hostname that only *resolves* to a private
 * address, a redirect to one, or an IPv6 form the check didn't anticipate.
 * This dispatcher instead: resolves DNS itself (never letting the
 * underlying client resolve implicitly at connect time), validates every
 * resolved address, refuses to auto-follow redirects (each hop is a new,
 * independently-validated request), and re-validates on every call — so a
 * retried delivery never trusts a cached "was safe" result from a previous
 * attempt (the practical DNS-rebinding mitigation named in §32.1).
 */

const IPV4_DENIED = new net.BlockList();
IPV4_DENIED.addSubnet("0.0.0.0", 8, "ipv4"); // "this network"
IPV4_DENIED.addSubnet("10.0.0.0", 8, "ipv4"); // RFC1918
IPV4_DENIED.addSubnet("100.64.0.0", 10, "ipv4"); // carrier-grade NAT
IPV4_DENIED.addSubnet("127.0.0.0", 8, "ipv4"); // loopback
IPV4_DENIED.addSubnet("169.254.0.0", 16, "ipv4"); // link-local, incl. cloud metadata 169.254.169.254
IPV4_DENIED.addSubnet("172.16.0.0", 12, "ipv4"); // RFC1918
IPV4_DENIED.addSubnet("192.0.0.0", 24, "ipv4"); // IETF protocol assignments
IPV4_DENIED.addSubnet("192.0.2.0", 24, "ipv4"); // TEST-NET-1
IPV4_DENIED.addSubnet("192.168.0.0", 16, "ipv4"); // RFC1918
IPV4_DENIED.addSubnet("198.18.0.0", 15, "ipv4"); // benchmarking
IPV4_DENIED.addSubnet("198.51.100.0", 24, "ipv4"); // TEST-NET-2
IPV4_DENIED.addSubnet("203.0.113.0", 24, "ipv4"); // TEST-NET-3
IPV4_DENIED.addSubnet("224.0.0.0", 4, "ipv4"); // multicast
IPV4_DENIED.addSubnet("240.0.0.0", 4, "ipv4"); // reserved/broadcast

// Deliberately a *separate* BlockList from the IPv4 one — adding an
// IPv4-mapped subnet (e.g. "::ffff:0:0/96") to a BlockList that's also
// asked to `check(addr, "ipv4")` makes it match every IPv4 address at all
// (verified empirically against this Node version's net.BlockList), since
// it internally compares IPv4 checks against mapped-IPv6 space too. IPv4-
// mapped IPv6 addresses are instead unwrapped and re-checked against
// IPV4_DENIED below (isDisallowedAddress), never matched via a subnet here.
const IPV6_DENIED = new net.BlockList();
IPV6_DENIED.addSubnet("::1", 128, "ipv6"); // loopback
IPV6_DENIED.addSubnet("::", 128, "ipv6"); // unspecified
IPV6_DENIED.addSubnet("fc00::", 7, "ipv6"); // unique local
IPV6_DENIED.addSubnet("fe80::", 10, "ipv6"); // link-local
IPV6_DENIED.addSubnet("ff00::", 8, "ipv6"); // multicast

const IPV4_MAPPED_IPV6 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i;

export function isDisallowedAddress(address: string, family: number): boolean {
  if (family === 4) return IPV4_DENIED.check(address, "ipv4");

  const mapped = address.match(IPV4_MAPPED_IPV6);
  if (mapped) return IPV4_DENIED.check(mapped[1], "ipv4");

  return IPV6_DENIED.check(address, "ipv6");
}

export class SSRFBlockedError extends Error {
  constructor(target: string, reason: string) {
    super(`Refusing to dispatch request to "${target}": ${reason}`);
    this.name = "SSRFBlockedError";
  }
}

interface ResolvedAddress {
  address: string;
  family: number;
}

/** Thin, test-mockable wrapper around `dns.promises.lookup` — every resolution the dispatcher performs goes through this one function. */
export async function resolveHostname(hostname: string): Promise<ResolvedAddress[]> {
  return dns.promises.lookup(hostname, { all: true, verbatim: true });
}

async function resolveAndValidate(hostname: string): Promise<ResolvedAddress[]> {
  let records: ResolvedAddress[];
  try {
    records = await resolveHostname(hostname);
  } catch (error) {
    throw new SSRFBlockedError(hostname, `DNS resolution failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (records.length === 0) {
    throw new SSRFBlockedError(hostname, "DNS resolution returned no addresses");
  }

  for (const { address, family } of records) {
    if (isDisallowedAddress(address, family)) {
      throw new SSRFBlockedError(hostname, `resolves to a disallowed address (${address})`);
    }
  }

  return records;
}

/**
 * Pins the connection's DNS resolution to the exact addresses already
 * validated above — there is no gap between "we checked this address" and
 * "we connect to this address" for the underlying `http`/`https` client to
 * resolve differently (the DNS-rebinding seam a naive validate-then-fetch
 * implementation would leave open).
 */
function pinnedLookup(records: ResolvedAddress[]): typeof dns.lookup {
  return ((hostname: string, optionsOrCallback: unknown, maybeCallback?: unknown) => {
    const callback = (typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback) as (
      err: NodeJS.ErrnoException | null,
      address: string | ResolvedAddress[],
      family?: number
    ) => void;
    const options = typeof optionsOrCallback === "object" && optionsOrCallback !== null ? (optionsOrCallback as { all?: boolean }) : {};

    if (options.all) {
      callback(null, records);
    } else {
      callback(null, records[0].address, records[0].family);
    }
  }) as typeof dns.lookup;
}

export interface DispatchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxRedirects?: number;
  /** Captures the final hop's response body as text (capped at `MAX_RESPONSE_BODY_BYTES`) — off by default, since most callers only need status. */
  includeResponseBody?: boolean;
}

export interface DispatchResult {
  ok: boolean;
  status: number;
  statusText: string;
  body?: string;
}

interface SingleHopResult {
  status: number;
  statusText: string;
  headers: http.IncomingHttpHeaders;
  body?: string;
}

const MAX_RESPONSE_BODY_BYTES = 1_000_000; // 1MB cap — a preview/test feature, never a bulk-transfer path

async function performRequest(
  url: URL,
  options: { method: string; headers?: Record<string, string>; body?: string; timeoutMs: number; includeResponseBody?: boolean }
): Promise<SingleHopResult> {
  const records = await resolveAndValidate(url.hostname);
  const lookup = pinnedLookup(records);
  const transport = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: options.method,
        headers: options.headers,
        lookup,
        timeout: options.timeoutMs,
      },
      (res) => {
        if (!options.includeResponseBody) {
          res.resume(); // most callers only need status/headers, never the body
          res.on("end", () => resolve({ status: res.statusCode ?? 0, statusText: res.statusMessage ?? "", headers: res.headers }));
          return;
        }

        const chunks: Buffer[] = [];
        let received = 0;
        res.on("data", (chunk: Buffer) => {
          if (received >= MAX_RESPONSE_BODY_BYTES) return;
          const remaining = MAX_RESPONSE_BODY_BYTES - received;
          const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
          chunks.push(slice);
          received += slice.length;
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? "",
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          })
        );
      }
    );
    req.on("timeout", () => req.destroy(new Error(`Request to "${url.hostname}" timed out after ${options.timeoutMs}ms`)));
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

/**
 * Dispatches one outbound HTTP(S) request, SSRF-validated at every hop.
 * Redirects (3xx with a `Location` header) are never auto-followed by the
 * underlying client (raw `http`/`https`, not `fetch`) — each is treated as
 * an independent request through this same function, so the redirect
 * target is resolved and validated exactly like the original URL, catching
 * an allowed URL that redirects to a disallowed one at the redirect hop
 * (§32.1 point 4). 301/302/303 drop the body and switch to GET per
 * standard HTTP redirect semantics; 307/308 preserve method and body.
 */
export async function dispatchHttpRequest(targetUrl: string, options: DispatchOptions = {}): Promise<DispatchResult> {
  const maxRedirects = options.maxRedirects ?? 5;
  const timeoutMs = options.timeoutMs ?? 10000;

  let currentUrl: URL;
  try {
    currentUrl = new URL(targetUrl);
  } catch {
    throw new SSRFBlockedError(targetUrl, "not a valid URL");
  }

  let method = options.method ?? "POST";
  let body = options.body;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (currentUrl.protocol !== "http:" && currentUrl.protocol !== "https:") {
      throw new SSRFBlockedError(currentUrl.toString(), `protocol "${currentUrl.protocol}" is not allowed`);
    }

    const response = await performRequest(currentUrl, {
      method,
      headers: options.headers,
      body,
      timeoutMs,
      includeResponseBody: options.includeResponseBody,
    });

    const isRedirect = response.status >= 300 && response.status < 400;
    const location = response.headers.location;
    if (isRedirect && typeof location === "string") {
      currentUrl = new URL(location, currentUrl);
      if (response.status !== 307 && response.status !== 308) {
        method = "GET";
        body = undefined;
      }
      continue;
    }

    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      statusText: response.statusText,
      body: response.body,
    };
  }

  throw new SSRFBlockedError(targetUrl, `too many redirects (max ${maxRedirects})`);
}
