import type { NextRequest } from "next/server";

const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

// Inside a container the server binds 0.0.0.0 so the published port is
// reachable, and Next builds request.url from that bind address. The browser --
// and therefore Google's redirect URI matching -- only ever sees the address in
// the address bar, so browser-facing absolute URLs are built from the Host
// header instead. The API proxy has already rejected any request whose Host is
// not loopback, so nothing else can reach this.
export function absoluteUrl(path: string, request: NextRequest) {
  const url = new URL(path, request.url);
  const host = request.headers.get("host");
  if (!host) return url;
  let hostname: string;
  try {
    hostname = new URL(`${url.protocol}//${host}`).hostname.toLowerCase();
  } catch {
    return url;
  }
  if (!loopbackHosts.has(hostname)) return url;
  url.host = host;
  return url;
}
