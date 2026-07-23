// Shared response helpers: verdict envelopes and small HTTP wrappers. Pure —
// safe to import under vitest without an Extism runtime.

/// A `Verdict::Skip`.
export function skip(): string {
  return JSON.stringify({ verdict: "skip" });
}

/// Wrap a JSON value as a `Verdict::Allow` HTTP response.
export function jsonResponse(status: number, value: unknown): string {
  return JSON.stringify({
    verdict: "allow",
    payload: {
      status,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    },
  });
}

/// Wrap an HTML body as a `Verdict::Allow` HTTP response. The core adds no
/// frame headers for `/plugin-api/*`, so the page ships its own
/// `frame-ancestors` policy to stay embeddable by the app but nobody else.
export function htmlResponse(status: number, body: string): string {
  return JSON.stringify({
    verdict: "allow",
    payload: {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "frame-ancestors 'self'",
      },
      body,
    },
  });
}
