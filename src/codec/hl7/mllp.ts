// =============================================================================
// MLLP (Minimal Lower Layer Protocol) framing — HL7 v2 over TCP.
//
//   on the wire:  VT <hl7 message text> FS CR
//
// Confirmed against the production capture from the Erba H360 hematology
// analyzer (E:\API_Integration\Devices\H360\H360.txt): every inbound ORU^R01
// starts with 0x0B and ends 0x1C 0x0D, and the legacy middleware's ACK is
// framed the same way.
//
// The decoder is deliberately tolerant: an analyzer that opens the stream with
// stray bytes, or one configured for "raw" HL7 with no VT at all, still yields
// usable messages — see `flushUnframed`.
// =============================================================================
export const VT = 0x0b; // start block
export const FS = 0x1c; // end block
export const CR = 0x0d;

/** Refuse to buffer more than this without a complete frame (runaway peer). */
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;

export function wrapMllp(text: string, encoding: BufferEncoding = 'utf8'): Buffer {
  return Buffer.concat([Buffer.from([VT]), Buffer.from(text, encoding), Buffer.from([FS, CR])]);
}

export class MllpDecoder {
  private buf = Buffer.alloc(0);

  constructor(private readonly encoding: BufferEncoding = 'utf8') {}

  get pending(): number {
    return this.buf.length;
  }

  /** Feed inbound bytes; returns every complete message they completed. */
  push(chunk: Buffer): string[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: string[] = [];

    for (;;) {
      // Drop anything before the start block — leading noise, or the CR the
      // peer left over from the previous frame's trailer.
      const start = this.buf.indexOf(VT);
      const end = this.buf.indexOf(FS);

      if (end === -1) break; // no complete block yet

      if (start === -1 || start > end) {
        // Block terminator with no start byte: an unframed sender, or we joined
        // the stream mid-message. Take everything up to FS as the message.
        out.push(this.take(0, end));
        continue;
      }

      if (start > 0) this.buf = this.buf.subarray(start); // discard the noise
      const fs = this.buf.indexOf(FS);
      if (fs === -1) break;
      out.push(this.take(1, fs));
    }

    if (this.buf.length > MAX_BUFFER_BYTES) {
      this.buf = Buffer.alloc(0);
      throw new Error('MLLP: no complete frame within 4 MB — buffer reset');
    }
    return out.map((m) => m.trim()).filter((m) => m.length > 0);
  }

  /**
   * Give up on framing and return whatever looks like a message. Called by the
   * link after an idle gap so a peer that never sends FS (raw HL7 over TCP)
   * still gets its results filed instead of sitting in the buffer forever.
   */
  flushUnframed(): string[] {
    if (this.buf.length === 0) return [];
    const text = this.buf.toString(this.encoding).replace(/[\x0b\x1c]/g, '').trim();
    this.buf = Buffer.alloc(0);
    return text.startsWith('MSH') ? [text] : [];
  }

  reset(): void {
    this.buf = Buffer.alloc(0);
  }

  /** Slice [from, end) out as text and consume through the trailer. */
  private take(from: number, end: number): string {
    const text = this.buf.subarray(from, end).toString(this.encoding);
    let next = end + 1; // past FS
    if (this.buf[next] === CR) next++; // past the trailer CR
    this.buf = this.buf.subarray(next);
    return text;
  }
}
