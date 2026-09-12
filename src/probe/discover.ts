// =============================================================================
// DISCOVERY — find the device before you probe it.
//
// Two problems come before "what protocol is this":
//   1. TCP. The analyzer is somewhere on the lab VLAN on some port. Its manual
//      says 5001; the biomed engineer set 4001 six years ago. Sweep and see.
//   2. Serial. Windows shows COM3, COM7 and COM12 and nothing says which is the
//      analyzer, let alone at what baud rate.
//
// Both scans are read-only: a TCP probe opens a socket and closes it, a serial
// probe opens the port, listens, and closes. Nothing is written to the device.
// =============================================================================
import net from 'node:net';
import type { Logger } from '../logger.js';

/**
 * Ports lab analyzers are actually found on. The first block is what the
 * machines this connector already drives use; the rest are the defaults of the
 * common LIS/analyzer stacks and terminal servers, because a device behind a
 * Moxa/Lantronix box answers on the box's port, not its own.
 */
export const COMMON_ANALYZER_PORTS = [
  // In use by analyzers this connector drives.
  2807, 4001, 5001, 5150,
  // Terminal / device servers (Moxa NPort, Lantronix, Digi) — one port per
  // serial channel, which is how a serial-only analyzer reaches the LAN.
  4002, 4003, 4004, 950, 9001, 9002, 10001, 10002, 10003, 10004, 8000, 8001,
  // HL7 MLLP conventions, plain and over TLS.
  2575, 2576, 6661, 6662, 7777, 3000,
  // ASTM / vendor middleware conventions.
  5000, 5002, 5003, 5010, 5100, 6000, 6100, 12000, 12001,
  // DICOM.
  104, 11112,
  // Patient monitors and point of care: Philips IntelliVue data export, the
  // POCT1-A observation reviewer, and the usual vendor gateway ports.
  24005, 24105, 5540, 7000, 7001,
  // Device web services / REST / FHIR.
  80, 443, 8080, 8443, 8088, 8081, 9443,
  // Instrument and building buses: Modbus, BACnet, OPC UA, MQTT.
  502, 802, 47808, 4840, 4843, 1883, 8883,
  // Management and file transfer — an analyzer with no LIS port often still
  // exports result files or answers SNMP.
  21, 22, 23, 161, 514, 445,
  // Raw print: an analyzer that "prints" its results to a network printer.
  9100, 9101, 9102,
  // Misc instrument defaults.
  1234, 2000, 2001, 4000, 5555,
];

export interface PortHit {
  host: string;
  port: number;
  /** ms to complete the TCP handshake — a proxy for "how close is this box". */
  latencyMs: number;
  /** Bytes the device volunteered within the listen window, rendered. */
  banner: string | null;
  /** A guess at what is listening, from the port number and any banner. */
  guess: string | null;
}

export interface ScanOptions {
  /** A single host, or a dotted range like 10.12.19.1-254. */
  host: string;
  ports: number[];
  connectTimeoutMs: number;
  /** How long to wait after connecting for the device to say something first. */
  bannerWaitMs: number;
  /** Sockets in flight. Kept modest — a lab VLAN switch is not a load target. */
  concurrency: number;
}

export const SCAN_DEFAULTS: Omit<ScanOptions, 'host' | 'ports'> = {
  connectTimeoutMs: 700,
  bannerWaitMs: 800,
  concurrency: 64,
};

/** Expand "10.12.19.5", "10.12.19.1-254" or "10.12.19.0/24" into addresses. */
export function expandHosts(spec: string): string[] {
  const s = spec.trim();

  const cidr = /^(\d+\.\d+\.\d+)\.(\d+)\/(\d+)$/.exec(s);
  if (cidr) {
    const bits = Number(cidr[3]);
    if (bits < 22 || bits > 32) throw new Error('only /22 to /32 are allowed — a wider sweep is not a lab scan');
    const octets = s.split('/')[0]!.split('.').map(Number);
    const addr = ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
    const size = 2 ** (32 - bits);
    const start = (addr & ~(size - 1)) >>> 0;
    const out: string[] = [];
    for (let i = 0; i < size; i++) {
      const a = (start + i) >>> 0;
      out.push([(a >>> 24) & 255, (a >>> 16) & 255, (a >>> 8) & 255, a & 255].join('.'));
    }
    // Drop network and broadcast for anything wider than a /31.
    return size > 2 ? out.slice(1, -1) : out;
  }

  const range = /^(\d+\.\d+\.\d+)\.(\d+)-(\d+)$/.exec(s);
  if (range) {
    const from = Number(range[2]);
    const to = Number(range[3]);
    if (from > to || to > 255) throw new Error(`"${s}" is not a valid address range`);
    if (to - from > 255) throw new Error('range too wide');
    const out: string[] = [];
    for (let i = from; i <= to; i++) out.push(`${range[1]}.${i}`);
    return out;
  }

  if (!/^[a-z0-9.-]+$/i.test(s)) throw new Error(`"${s}" is not a host, range or CIDR`);
  return [s];
}

/**
 * What is probably listening on a port. A guess, clearly labelled as one — the
 * point is to save the operator a lookup, never to skip the probe.
 */
function guessService(port: number, banner: string | null): string | null {
  if (banner) {
    if (/MSH\|/.test(banner)) return 'HL7 — the device greeted us with an MSH segment';
    if (/<05>|<02>|<ENQ>|<STX>/.test(banner)) return 'ASTM — the device opened an E1381 session immediately';
    if (/^HTTP\//.test(banner)) return 'HTTP service';
    if (/^SSH-/.test(banner)) return 'SSH';
    if (/DICM/.test(banner)) return 'DICOM';
    // A TLS record layer means every later probe of this port is wasted effort.
    if (/^<16><03>/.test(banner)) return 'TLS — the port is encrypted; a raw probe will never see plaintext';
    if (/^<FF><F[BCDE]>/.test(banner)) return 'telnet negotiation — put the terminal server channel in RAW mode';
    if (/^220[ -]/.test(banner)) return 'FTP or SMTP — the device may export result files here';
    if (/^<81>/.test(banner)) return 'BACnet/IP';
    if (/^(HEL|ACK|MSG|OPN)[FCA]/.test(banner)) return 'OPC UA binary';
  }
  const byPort: Record<number, string> = {
    21: 'FTP — an analyzer that exports result FILES rather than streaming them',
    22: 'SSH',
    23: 'telnet — if this is a terminal server, switch the channel to RAW mode',
    104: 'DICOM (well-known port)',
    161: 'SNMP — the management plane, not the result feed',
    502: 'Modbus/TCP (well-known port)',
    514: 'syslog — device events',
    1883: 'MQTT broker (plain)',
    2575: 'HL7 MLLP (IANA-assigned)',
    2807: 'Snibe Maglumi ASTM (as configured at this site)',
    4001: 'terminal-server serial channel 1 (Moxa/Lantronix) — very often an ASTM analyzer',
    4840: 'OPC UA binary',
    5001: 'analyzer ASTM/HL7 (common vendor default)',
    8883: 'MQTT over TLS',
    9100: 'raw print port — an analyzer that "prints" its results',
    11112: 'DICOM (IANA-assigned)',
    24005: 'Philips IntelliVue data export',
    47808: 'BACnet/IP (0xBAC0)',
    80: 'HTTP',
    443: 'HTTPS — the payload is encrypted; a raw probe will see nothing',
  };
  return byPort[port] ?? null;
}

/** Try one host:port. Resolves to a hit or null; never throws. */
function probePort(host: string, port: number, o: ScanOptions): Promise<PortHit | null> {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = new net.Socket();
    let settled = false;
    let banner: Buffer[] = [];
    let bannerTimer: NodeJS.Timeout | null = null;

    const finish = (hit: PortHit | null) => {
      if (settled) return;
      settled = true;
      if (bannerTimer) clearTimeout(bannerTimer);
      socket.destroy();
      resolve(hit);
    };

    socket.setTimeout(o.connectTimeoutMs);
    socket.once('timeout', () => finish(null));
    socket.once('error', () => finish(null));

    socket.connect(port, host, () => {
      const latencyMs = Date.now() - started;
      // Many analyzers announce themselves the moment a host connects (an ENQ,
      // an MSH, a login banner). Wait briefly for that — it is free evidence.
      socket.setTimeout(0);
      bannerTimer = setTimeout(() => {
        const buf = Buffer.concat(banner);
        const rendered = buf.length ? renderShort(buf) : null;
        finish({ host, port, latencyMs, banner: rendered, guess: guessService(port, rendered) });
      }, o.bannerWaitMs);
      socket.on('data', (c) => {
        banner.push(c);
        if (Buffer.concat(banner).length > 512) {
          const buf = Buffer.concat(banner).subarray(0, 512);
          const rendered = renderShort(buf);
          finish({ host, port, latencyMs, banner: rendered, guess: guessService(port, rendered) });
        }
      });
    });
  });
}

function renderShort(buf: Buffer): string {
  let out = '';
  for (const b of buf.subarray(0, 200)) {
    if (b >= 0x20 && b <= 0x7e) out += String.fromCharCode(b);
    else out += `<${b.toString(16).padStart(2, '0').toUpperCase()}>`;
  }
  return out;
}

export interface ScanResult {
  scanned: number;
  hits: PortHit[];
  elapsedMs: number;
}

/** Sweep hosts × ports with a bounded worker pool. */
export async function scanTcp(opts: Partial<ScanOptions> & { host: string }, logger?: Logger): Promise<ScanResult> {
  const o: ScanOptions = { ...SCAN_DEFAULTS, ports: COMMON_ANALYZER_PORTS, ...opts };
  const hosts = expandHosts(o.host);
  const targets: [string, number][] = [];
  for (const h of hosts) for (const p of o.ports) targets.push([h, p]);
  if (targets.length > 20000) throw new Error(`${targets.length} probes is too many — narrow the host range or the port list`);

  const started = Date.now();
  const hits: PortHit[] = [];
  let next = 0;

  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= targets.length) return;
      const [h, p] = targets[i]!;
      const hit = await probePort(h, p, o);
      if (hit) hits.push(hit);
    }
  };
  await Promise.all(Array.from({ length: Math.min(o.concurrency, targets.length) }, worker));

  hits.sort((a, b) => (a.host === b.host ? a.port - b.port : a.host.localeCompare(b.host)));
  logger?.info({ hosts: hosts.length, ports: o.ports.length, hits: hits.length }, 'connector-tool tcp scan complete');
  return { scanned: targets.length, hits, elapsedMs: Date.now() - started };
}

// -----------------------------------------------------------------------------
// Serial
// -----------------------------------------------------------------------------

export interface SerialPortInfo {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  pnpId?: string;
  vendorId?: string;
  productId?: string;
  friendlyName?: string;
}

/** Enumerate COM ports. Empty (with a reason) when serialport isn't installed. */
export async function listSerialPorts(): Promise<{ ports: SerialPortInfo[]; error: string | null }> {
  try {
    const { SerialPort } = (await import('serialport')) as any;
    const ports = (await SerialPort.list()) as SerialPortInfo[];
    return { ports, error: null };
  } catch (err) {
    return {
      ports: [],
      error:
        err instanceof Error && /Cannot find module|ERR_MODULE_NOT_FOUND/.test(err.message)
          ? 'the "serialport" package is not installed — run: npm install serialport'
          : err instanceof Error
            ? err.message
            : String(err),
    };
  }
}

/** Baud rates worth trying, commonest first — an RS-232 analyzer is one of these. */
export const COMMON_BAUD_RATES = [9600, 19200, 38400, 115200, 4800, 57600, 2400, 1200];

export interface BaudTrial {
  baudRate: number;
  bytes: number;
  /** Share of bytes that are printable ASCII — the framing-agnostic score. */
  printableRatio: number;
  sample: string | null;
}

/**
 * Listen on a serial port at each candidate baud rate and keep whichever
 * produced sane-looking data. A wrong baud rate does not fail — it delivers
 * plausible-looking garbage — so the discriminator is the printable ratio plus
 * whether any lab control character (STX/ENQ/CR) shows up where it should.
 *
 * The device must be transmitting for this to work; the caller is expected to
 * tell the operator to press "send" on the analyzer first.
 */
export async function sweepBaudRates(
  path: string,
  opts: { rates?: number[]; listenMsPerRate?: number } = {},
): Promise<{ trials: BaudTrial[]; best: BaudTrial | null; error: string | null }> {
  let SerialPortCtor: any;
  try {
    ({ SerialPort: SerialPortCtor } = (await import('serialport')) as any);
  } catch {
    return { trials: [], best: null, error: 'the "serialport" package is not installed — run: npm install serialport' };
  }

  const rates = opts.rates ?? COMMON_BAUD_RATES;
  const listenMs = opts.listenMsPerRate ?? 3000;
  const trials: BaudTrial[] = [];

  for (const baudRate of rates) {
    const chunks: Buffer[] = [];
    try {
      await new Promise<void>((resolve, reject) => {
        const port = new SerialPortCtor({ path, baudRate }, (err: Error | null) => {
          if (err) return reject(err);
          port.set({ dtr: true, rts: true }, () => {});
          setTimeout(() => port.close(() => resolve()), listenMs);
        });
        port.on('data', (c: Buffer) => chunks.push(c));
        port.on('error', (err: Error) => reject(err));
      });
    } catch (err) {
      trials.push({ baudRate, bytes: 0, printableRatio: 0, sample: err instanceof Error ? err.message : String(err) });
      continue;
    }
    const buf = Buffer.concat(chunks);
    const printable = [...buf].filter((b) => (b >= 0x20 && b <= 0x7e) || b === 0x0d || b === 0x0a || b < 0x08).length;
    trials.push({
      baudRate,
      bytes: buf.length,
      printableRatio: buf.length ? Math.round((printable / buf.length) * 100) / 100 : 0,
      sample: buf.length ? renderShort(buf) : null,
    });
  }

  // Prefer the rate that produced data at all, then the cleanest data. A rate
  // that saw nothing tells us nothing, so it can never win.
  const best =
    trials
      .filter((t) => t.bytes > 0)
      .sort((a, b) => b.printableRatio - a.printableRatio || b.bytes - a.bytes)[0] ?? null;
  return { trials, best, error: null };
}
