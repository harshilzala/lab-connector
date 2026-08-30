// =============================================================================
// ADVIA 2120i host-link framing (reverse-engineered from the caretech
// Middleware.exe and VALIDATED against a real captured frame).
//
// Wire frame:   STX  <payload>  <checksum>  ETX
//   checksum = XOR of every byte of <payload>, emitted as one raw byte.
//   (Verified: payload "Y","S",10×space,CR,LF  ->  XOR = 0x0D, which matched the
//    byte before ETX in the live capture `02 59 53 …20 0D 0A 0D 03`.)
//
// payload = <seqChar> <typeChar> <data…> CR LF
//   seqChar  : a single byte that the analyzer increments by 2 on every frame
//              (…'9' ';' '=' '?' 'A' 'C'… = 0x39,0x3b,0x3d,0x3f,0x41,0x43…).
//   typeChar : 'S' status/token (keep-alive), 'R' result, 'Z'/'M'/'N' control.
// =============================================================================
export const STX = 0x02;
export const ETX = 0x03;
export const CR = 0x0d;
export const LF = 0x0a;
// ASTM E1381 line-control bytes used for establishment/acknowledgement.
export const ENQ = 0x05; // "I want to send" / poll
export const ACK = 0x06; // frame accepted
export const NAK = 0x15; // frame rejected (this is what the ADVIA sent us)
export const EOT = 0x04; // end of transmission

/** XOR checksum over the payload bytes (the ADVIA token-frame check byte). */
export function xorChecksum(payload: Buffer): number {
  let c = 0;
  for (const b of payload) c ^= b;
  return c & 0xff;
}

/** Wrap a payload string as a complete on-wire frame: STX payload XOR ETX. */
export function buildFrame(payload: string): Buffer {
  const body = Buffer.from(payload, 'latin1');
  return Buffer.concat([Buffer.from([STX]), body, Buffer.from([xorChecksum(body), ETX])]);
}

export interface AdviaFrame {
  seq: number; // the seqChar byte
  type: string; // typeChar, e.g. 'S' | 'R' | 'Z'
  payload: string; // full payload (seq + type + data + CR LF), latin1
  checksumOk: boolean;
}

/**
 * Pull complete STX…ETX frames out of an accumulating buffer.
 * Returns the parsed frames and the unconsumed remainder (partial tail).
 */
export function extractFrames(buf: Buffer): { frames: AdviaFrame[]; rest: Buffer } {
  const frames: AdviaFrame[] = [];
  let i = 0;
  let consumed = 0;
  while (i < buf.length) {
    const stx = buf.indexOf(STX, i);
    if (stx === -1) break;
    const etx = buf.indexOf(ETX, stx + 1);
    if (etx === -1) break; // frame still arriving
    // content between STX and ETX = payload + 1 checksum byte
    const inner = buf.subarray(stx + 1, etx);
    if (inner.length >= 1) {
      const payload = inner.subarray(0, inner.length - 1);
      const cksum = inner[inner.length - 1]!;
      frames.push({
        seq: payload[0] ?? 0,
        type: String.fromCharCode(payload[1] ?? 0),
        payload: payload.toString('latin1'),
        checksumOk: xorChecksum(payload) === cksum,
      });
    }
    i = etx + 1;
    consumed = i;
  }
  return { frames, rest: buf.subarray(consumed) };
}

/** Next seq byte: the analyzer steps by 2 and stays in a printable band. */
export function nextSeq(seq: number): number {
  let s = seq + 2;
  if (s > 0x7e) s = 0x30 + (s - 0x7e); // wrap conservatively; refine on the bench
  return s & 0xff;
}
