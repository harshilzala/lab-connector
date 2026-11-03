import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';

// =============================================================================
// One HTTP call with an optional client certificate (mTLS).
//
// Without `tls` this is plain fetch(), exactly as every gateway used before.
// With `tls` (a cert + key, optionally a CA) it goes through node:https so the
// certificate can be presented — the ZyHos partner contract marks acknowledge
// and results "HIGH security — may require mTLS".
//
// Errors are shaped like fetch's so callers classify them the same way:
// a timeout throws an Error named "AbortError", a connect/DNS/TLS failure a
// TypeError with the cause attached.
// =============================================================================

export interface ClientTls {
  certFile: string;
  keyFile: string;
  caFile?: string;
  passphrase?: string;
}

export interface HttpCall {
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  tls?: ClientTls | null;
}

export async function httpSend(url: string, call: HttpCall): Promise<{ status: number; text: string }> {
  if (!call.tls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), call.timeoutMs);
    try {
      const res = await fetch(url, { method: call.method, headers: call.headers, body: call.body, signal: controller.signal });
      return { status: res.status, text: await res.text() };
    } finally {
      clearTimeout(timer);
    }
  }
  return httpsWithCert(url, call, call.tls);
}

const certCache = new Map<string, Buffer>();
function readOnce(file: string): Buffer {
  let b = certCache.get(file);
  if (!b) {
    b = readFileSync(file);
    certCache.set(file, b);
  }
  return b;
}

function httpsWithCert(url: string, call: HttpCall, tls: ClientTls): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method: call.method,
        headers: call.body === undefined ? call.headers : { ...call.headers, 'content-length': String(Buffer.byteLength(call.body)) },
        cert: readOnce(tls.certFile),
        key: readOnce(tls.keyFile),
        ca: tls.caFile ? readOnce(tls.caFile) : undefined,
        passphrase: tls.passphrase || undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', (err) => reject(asTypeError(err)));
      },
    );
    req.setTimeout(call.timeoutMs, () => {
      const err = new Error(`timed out after ${call.timeoutMs}ms`);
      err.name = 'AbortError';
      req.destroy(err);
    });
    req.on('error', (err) => reject(err.name === 'AbortError' ? err : asTypeError(err)));
    if (call.body !== undefined) req.write(call.body);
    req.end();
  });
}

function asTypeError(cause: Error): TypeError {
  const e = new TypeError(cause.message);
  (e as TypeError & { cause: unknown }).cause = cause;
  return e;
}
