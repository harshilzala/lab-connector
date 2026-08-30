import { STX, ETX, CR, LF } from './control.js';

// -----------------------------------------------------------------------------
// ASTM E1381 frame checksum.
//
// A frame on the wire is:   <STX> FN text (ETB|ETX) C1 C2 <CR><LF>
//
// The checksum is the modulo-256 sum of every byte AFTER <STX> up to and
// INCLUDING the ETB/ETX terminator, rendered as two UPPERCASE hex characters
// (C1 = high nibble, C2 = low nibble).
// -----------------------------------------------------------------------------

/**
 * Compute the two checksum characters for a frame body.
 * @param body the bytes from just after STX through the ETB/ETX (inclusive).
 */
export function checksum(body: Buffer): string {
  let sum = 0;
  for (const b of body) sum = (sum + b) & 0xff;
  return sum.toString(16).toUpperCase().padStart(2, '0');
}

/**
 * Build a complete framed byte buffer.
 * @param frameNo running frame number (0–7; wraps)
 * @param text the record text (may be a slice of a long record)
 * @param terminator ETB for a continued record, ETX for the final frame
 */
export function frame(frameNo: number, text: string, terminator: typeof ETX | number): Buffer {
  const fn = String(frameNo % 8);
  const body = Buffer.concat([Buffer.from(fn + text, 'latin1'), Buffer.from([terminator])]);
  const cs = Buffer.from(checksum(body), 'latin1');
  return Buffer.concat([Buffer.from([STX]), body, cs, Buffer.from([CR, LF])]);
}

/**
 * Verify a received frame's checksum.
 * @param body bytes from just after STX up to and including ETB/ETX
 * @param received the two checksum characters that followed the terminator
 */
export function verifyChecksum(body: Buffer, received: string): boolean {
  return checksum(body).toUpperCase() === received.toUpperCase();
}
