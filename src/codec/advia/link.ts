import { EventEmitter } from 'node:events';
import type { Transport } from '../../transport/types.js';
import type { Logger } from '../../logger.js';
import type { InstrumentResult, OrderDownload, ParsedMessage } from '../../types.js';
import type { ProtocolLink } from '../types.js';

// =============================================================================
// Advia2120Link — faithful reimplementation of the ADVIA 2120i host protocol,
// ported from the original vendor source (LabIntegration/BHU/ADVIA_2120i.cs).
//
// The link is a token/frame protocol over serial:
//   frame on the wire:  STX <payload> <xorChecksum> ETX
//   payload          :  <seqChar> <typeChar> <data…> CR LF
//
// Establishment + steady state (exactly as the vendor code does it):
//   • a timer periodically sends StartComm ( STX "0I \r\n" XOR ETX ) until the
//     analyzer starts talking; a bare '0' back means "establish" → TokenTransfer(49);
//   • on every complete frame the host FIRST echoes the seq char (single-byte ACK),
//     then: 'S' → TokenTransfer(token)  (keep-alive / token pass),
//            'R' → parse the CBC + ValidResult(token),
//            'Q' → YOrder(...)          (host query / order download),
//            'E' → nothing further.
//   • token = ValidMT(seq): seq>89 ? 48 : seq+1.
// =============================================================================
const STX = 2;
const ETX = 3;
const CR = 13;
const LF = 10;

export interface Advia2120LinkOptions {
  logger: Logger;
  /** Machine id echoed with results (legacy App.config MachineId, e.g. 901). */
  machineId?: number;
  /** Re-send StartComm if the line is idle this long (ms). */
  startCommIdleMs?: number;
}

export class Advia2120Link extends EventEmitter implements ProtocolLink {
  readonly name = 'advia2120i' as const;

  private buf = ''; // raw inbound accumulator (latin1)
  private rec = ''; // current frame payload being assembled (strDataReceived)
  private startFlg = false;
  private initialFlg = false;
  private messageToken = 0;
  private lastRxAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly startCommIdleMs: number;
  private readonly onDataBound = (c: Buffer) => this.onData(c);

  constructor(private readonly transport: Transport, private readonly opts: Advia2120LinkOptions) {
    super();
    this.startCommIdleMs = opts.startCommIdleMs ?? 15000;
  }

  async start(): Promise<void> {
    this.transport.on('data', this.onDataBound);
    this.transport.on('error', (e: Error) => this.emit('error', e));
    await this.transport.start();
    this.startComm(); // announce the host immediately
    this.timer = setInterval(() => this.onTick(), 5000);
  }

  async stop(): Promise<void> {
    this.transport.off('data', this.onDataBound);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.transport.stop();
  }

  async sendOrders(orders: OrderDownload[]): Promise<void> {
    if (orders.length > 0) {
      this.opts.logger.warn({ count: orders.length }, 'ADVIA 2120i: sendOrders handled via YOrder on Q frames — ignoring push');
    }
  }

  private onTick(): void {
    // Vendor behaviour: re-issue StartComm when no data has been arriving.
    if (this.now() - this.lastRxAt >= this.startCommIdleMs) this.startComm();
  }

  // ---- inbound: InitiateComm (byte pump) -------------------------------------
  private onData(chunk: Buffer): void {
    this.lastRxAt = this.now();
    this.emit('wire', { direction: 'IN', text: hexAscii(chunk) });
    const s = chunk.toString('latin1');
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i) & 0xff;
      const ch = s[i]!;
      switch (code) {
        case STX:
          if (!this.startFlg) {
            this.rec = '';
            this.startFlg = true;
          } else {
            this.rec += ch;
          }
          break;
        case ETX:
          this.formateData(this.rec);
          this.rec = '';
          this.startFlg = false;
          break;
        case 48: // '0'
          if (this.initialFlg) {
            this.tokenTransfer(49);
            this.initialFlg = false;
          } else {
            this.rec += ch;
          }
          break;
        default:
          this.rec += ch;
      }
    }
  }

  // ---- FormateData: dispatch one complete frame payload ----------------------
  private formateData(str: string): void {
    if (str.length < 2) return;
    const type = str[1];
    this.writeRaw(str[0]!, `echo-seq(${type})`); // per-frame ACK: echo the seq char
    try {
      switch (type) {
        case 'E':
          break;
        case 'S':
          this.validMT(str.charCodeAt(0) & 0xff);
          this.tokenTransfer(this.messageToken);
          break;
        case 'R':
          this.parseResult(str);
          this.validMT(str.charCodeAt(0) & 0xff);
          this.validResult(this.messageToken);
          break;
        case 'Q': {
          this.validMT(str.charCodeAt(0) & 0xff);
          const sin = zeroTruncation(str.substring(3, 3 + 14).trim());
          this.yOrder(sin, this.messageToken);
          break;
        }
        default:
          break;
      }
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }

  private parseResult(str: string): void {
    const parray = str.split(/[\r\n]/).filter((x) => x.length > 0);
    if (parray.length < 2) return;
    const sampleId = zeroTruncation(parray[0]!.substring(3, 3 + 14).trim());
    let rmsg = parray[1]!;
    if (rmsg.includes('|')) rmsg = removeFlags(rmsg);
    const results: InstrumentResult[] = [];
    let j = 0;
    while (j < rmsg.length - 1) {
      const testCode = rmsg.substring(j, j + 3).trim();
      j += 3;
      const value = rmsg.substring(j, j + 6).trim();
      j += 6;
      if (testCode) results.push({ sampleId, testCode, value, instrument: 'ADVIA2120I' });
    }
    if (results.length === 0) return;
    const msg: ParsedMessage = {
      protocol: 'advia2120i',
      sender: 'ADVIA2120I',
      patient: null,
      queries: [],
      results,
      raw: str,
    };
    this.emit('message', msg);
    this.opts.logger.info({ sample: sampleId, fields: results.length }, 'ADVIA result parsed');
  }

  private validMT(m: number): void {
    this.messageToken = m > 89 ? 48 : m + 1;
  }

  // ---- outbound frames -------------------------------------------------------
  private startComm(): void {
    const payload = '0' + 'I ' + '\r\n'; // "0I \r\n"
    this.writeFrame(payload, xorStr(payload), 'startcomm');
    this.initialFlg = true;
  }

  private tokenTransfer(g: number): void {
    const payload = String.fromCharCode(g) + 'S          ' + '\r\n'; // 'S' + 10 spaces
    let c = xorStr(payload);
    if (c === 3) c = 127; // never let the check byte collide with ETX
    this.writeFrame(payload, c, 'token');
  }

  private validResult(ch: number): void {
    const payload = String.fromCharCode(ch) + 'Z                  0' + '\r\n'; // 'Z' + 18 spaces + '0'
    this.writeFrame(payload, xorStr(payload), 'validresult');
  }

  // Order download in reply to a 'Q' query. Without an HMIS order lookup we send
  // the vendor's default full-CBC test list (its "no patient found" branch).
  private yOrder(sin: string, mt: number): void {
    const now = new Date();
    const mmddyy = `${p2(now.getMonth() + 1)}/${p2(now.getDate())}/${p2(now.getFullYear() % 100)}`;
    const hhmm = `${p2(now.getHours())}${p2(now.getMinutes())}`;
    const tests =
      '001002003004005006007008009010011051072020021022023024025014015016017018019013012037038040041077078076081079075042043044082';
    const payload =
      String.fromCharCode(mt) +
      'Y  U  ' +
      sin.padStart(14, ' ') +
      ''.padStart(25, ' ') +
      ''.padStart(14, ' ') +
      '  ' +
      ''.padStart(31, ' ') +
      ' ' +
      '          ' +
      ' ' +
      'U' +
      ' ' +
      mmddyy +
      ' ' +
      hhmm +
      ' ' +
      ''.padStart(14, ' ') +
      '\r\n' +
      tests +
      '\r\n';
    this.writeFrame(payload, xorStr(payload), 'yorder');
  }

  private writeFrame(payload: string, cksum: number, why: string): void {
    const frame = String.fromCharCode(STX) + payload + String.fromCharCode(cksum) + String.fromCharCode(ETX);
    this.writeRaw(frame, why);
  }

  private writeRaw(s: string, why: string): void {
    const b = Buffer.from(s, 'latin1');
    this.emit('wire', { direction: 'OUT', text: `${why} ${hexAscii(b)}` });
    this.transport.write(b).catch((e) => this.emit('error', e instanceof Error ? e : new Error(String(e))));
  }

  private now(): number {
    return Number(process.hrtime.bigint() / 1_000_000n);
  }
}

/** XOR of every char code — the ADVIA frame check byte. */
function xorStr(s: string): number {
  let c = 0;
  for (let i = 0; i < s.length; i++) c ^= s.charCodeAt(i) & 0xff;
  return c & 0xff;
}

/** Strip leading zeros from a sample id (vendor ZeroTruncation). */
function zeroTruncation(id: string): string {
  let out = '';
  let started = false;
  for (const ch of id) {
    if (ch === '0' && !started) continue;
    started = true;
    out += ch;
  }
  return out;
}

/** Remove embedded |…| morphology flag sections (vendor RemoveFlags). */
function removeFlags(s: string): string {
  let start = false;
  let end = false;
  let si = 0;
  let ei = 0;
  for (let i = 20; i < s.length - 1; i++) {
    if (!start && s[i] === '|') {
      start = true;
      si = i;
      continue;
    }
    if (!end && start && s[i] === '|') {
      end = true;
      ei = i + 1;
    }
    if (start && end) {
      start = false;
      end = false;
      s = s.slice(0, si) + s.slice(ei);
      i -= 20;
    }
  }
  return s;
}

const p2 = (n: number) => String(n).padStart(2, '0');

function hexAscii(buf: Buffer): string {
  const hex = Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join(' ');
  const asc = Array.from(buf, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
  return `${hex}  |${asc}|`;
}
