import dns from 'node:dns';
import type { Logger } from '../logger.js';

// =============================================================================
// hmis.hosts — a hosts-file entry for this process only.
//
// GenX UAT (genxuat.zhhrpl.in) has no record in the lab's internal DNS, and
// editing C:\Windows\System32\drivers\etc\hosts needs administrator rights.
// Calling the IP directly does not work either: the certificate is for
// *.zhhrpl.in, so TLS refuses https://43.205.50.17, and switching certificate
// checks off (tlsRejectUnauthorized) would do it for HINAI's live traffic too.
//
// So the URL keeps the host NAME and only the lookup is answered here: fetch
// and node:https both resolve through dns.lookup, the TLS handshake still
// sends the name (SNI) and verifies the certificate against it. Any name not
// listed goes to the system resolver exactly as before.
// =============================================================================

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

let installed: Map<string, string> | null = null;

export function installHostPins(hosts: Record<string, string>, log: Logger): void {
  const pins = new Map(Object.entries(hosts).map(([h, ip]) => [h.trim().toLowerCase(), ip.trim()] as const).filter(([h, ip]) => h && ip));
  if (!pins.size) return;
  if (installed) {
    for (const [h, ip] of pins) installed.set(h, ip);
    return;
  }
  installed = pins;
  const original = dns.lookup.bind(dns) as (...a: unknown[]) => void;
  const pinned = (hostname: string, options: unknown, callback?: LookupCb): void => {
    const cb = (typeof options === 'function' ? options : callback) as LookupCb;
    const opts = (typeof options === 'object' && options !== null ? options : {}) as dns.LookupOptions;
    const ip = installed?.get(String(hostname).toLowerCase());
    if (!ip) {
      original(hostname, options, callback);
      return;
    }
    process.nextTick(() => (opts.all ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4)));
  };
  (dns as unknown as { lookup: unknown }).lookup = pinned;
  log.info({ hosts: Object.fromEntries(pins) }, 'hmis.hosts: these names resolve to fixed addresses inside the connector (TLS still verified against the name)');
}
