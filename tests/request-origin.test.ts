import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { absoluteUrl } from "../lib/request-origin";

function requestFrom(url: string, host?: string) {
  return new NextRequest(url, { headers: host ? { host } : {} });
}

test("the redirect URI follows the address bar, not the container bind address", () => {
  const request = requestFrom("http://0.0.0.0:3000/api/auth/google/start", "localhost:3000");
  assert.equal(
    absoluteUrl("/api/auth/google/callback", request).toString(),
    "http://localhost:3000/api/auth/google/callback",
  );
});

test("a host that is not loopback cannot rewrite the redirect URI", () => {
  const request = requestFrom("http://0.0.0.0:3000/api/auth/google/start", "attacker.example");
  assert.equal(
    absoluteUrl("/api/auth/google/callback", request).toString(),
    "http://0.0.0.0:3000/api/auth/google/callback",
  );
});

test("a missing or unparsable host falls back to the request URL", () => {
  assert.equal(
    absoluteUrl("/x", requestFrom("http://0.0.0.0:3000/api/auth/google/start")).toString(),
    "http://0.0.0.0:3000/x",
  );
  assert.equal(
    absoluteUrl("/x", requestFrom("http://0.0.0.0:3000/api/auth/google/start", "not a host")).toString(),
    "http://0.0.0.0:3000/x",
  );
});

test("query strings survive the rewrite", () => {
  const request = requestFrom("http://0.0.0.0:3000/api/auth/google/callback", "localhost:3000");
  assert.equal(
    absoluteUrl("/?tab=settings&section=newsletters", request).toString(),
    "http://localhost:3000/?tab=settings&section=newsletters",
  );
});
