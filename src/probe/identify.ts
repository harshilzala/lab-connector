// =============================================================================
// PROTOCOL FINGERPRINTING
//
// Given a raw capture of whatever an unknown device put on the wire, score it
// against every framing we know about and rank the candidates. This is the
// analysis half of the Connector Tool: plug a new machine into a port, let it
// transmit once, and this says what it is speaking and — for the protocols this
// connector already implements — the exact config.json block to add.
//
// WHY SCORING AND NOT A SWITCH
// Medical device protocols overlap, layer and disagree. ASTM E1394 records
// travel inside E1381 framing on most analyzers, bare inside SOH…EOT on a
// Radiometer ABL9, and inside a Kermit file transfer on a VITROS 250. HL7
// travels inside MLLP, inside a file, or raw. A monitor's "protocol" may turn
// out to be an IEEE 11073 APDU, a vendor ASCII frame, or Modbus underneath.
// A single "is it X" test therefore mislabels as often as it labels, so every
// detector returns evidence and a confidence, and the caller sees the ranking.
//
// WHAT A DETECTOR MAY CLAIM
// Structure only — magic numbers, framing, and above all VERIFIED CHECKSUMS.
// A detector never claims a vendor from vocabulary alone: "these look like
// hematology mnemonics" is a lead, not an identification, and is scored like
// one. Where a family is recognisable but the vendor is not, the detector says
// so and names what to check in the host-interface spec. Guessing confidently
// is worse than useless here — it sends a biomed engineer down a blind alley.
//
// Each detector is independent and cheap: they all run over the same buffer,
// and adding one is a new entry in DETECTORS — nothing else moves.
// =============================================================================

/** Control characters that carry meaning in the protocols we handle. */
export const CTRL = {
  SOH: 0x01,
  STX: 0x02,
  ETX: 0x03,
  EOT: 0x04,
  ENQ: 0x05,
  ACK: 0x06,
  BEL: 0x07,
  BS: 0x08,
  TAB: 0x09,
  LF: 0x0a,
  VT: 0x0b,
  FF: 0x0c,
  CR: 0x0d,
  DLE: 0x10,
  XON: 0x11,
  XOFF: 0x13,
  NAK: 0x15,
  SYN: 0x16,
  ETB: 0x17,
  CAN: 0x18,
  ESC: 0x1b,
  FS: 0x1c,
  GS: 0x1d,
  RS: 0x1e,
  US: 0x1f,
} as const;

const CTRL_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(CTRL).map(([k, v]) => [v, k]),
) as Record<number, string>;

/**
 * Render bytes so a human can read them in the UI: printable ASCII verbatim,
 * every control character as its mnemonic, anything else as hex. This is the
 * same convention the wire log uses, so a capture and a wire log line look
 * alike.
 */
export function renderBytes(buf: Buffer): string {
  let out = '';
  for (const b of buf) {
    if (b >= 0x20 && b <= 0x7e) out += String.fromCharCode(b);
    else if (CTRL_NAME[b]) out += `<${CTRL_NAME[b]}>`;
    else out += `<${b.toString(16).padStart(2, '0').toUpperCase()}>`;
  }
  return out;
}

/** Parse a user-typed payload into bytes. Accepts text with escapes, or hex. */
export function parsePayload(text: string, mode: 'text' | 'hex'): Buffer {
  if (mode === 'hex') {
    const hex = text.replace(/0x/gi, '').replace(/[^0-9a-f]/gi, '');
    if (hex.length % 2 !== 0) throw new Error('hex payload has an odd number of digits');
    return Buffer.from(hex, 'hex');
  }
  // Text mode understands the mnemonics the UI shows (<ENQ>, <STX>, <0D>) plus
  // the usual backslash escapes, so a frame can be retyped from a wire log.
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '<') {
      const end = text.indexOf('>', i);
      if (end > i) {
        const token = text.slice(i + 1, end).toUpperCase();
        const named = (CTRL as Record<string, number>)[token];
        if (named !== undefined) {
          out.push(named);
          i = end;
          continue;
        }
        if (/^[0-9A-F]{2}$/.test(token)) {
          out.push(parseInt(token, 16));
          i = end;
          continue;
        }
      }
    }
    if (ch === '\\' && i + 1 < text.length) {
      const n = text[i + 1]!;
      const simple: Record<string, number> = { r: 0x0d, n: 0x0a, t: 0x09, '0': 0x00, '\\': 0x5c };
      if (simple[n] !== undefined) {
        out.push(simple[n]!);
        i++;
        continue;
      }
      if (n === 'x' && /^[0-9a-f]{2}$/i.test(text.slice(i + 2, i + 4))) {
        out.push(parseInt(text.slice(i + 2, i + 4), 16));
        i += 3;
        continue;
      }
    }
    out.push(ch.charCodeAt(0) & 0xff);
  }
  return Buffer.from(out);
}

// -----------------------------------------------------------------------------
// Detector contract
// -----------------------------------------------------------------------------

/**
 * Which corner of the estate a protocol belongs to. The UI groups by this,
 * because "what kind of box is this" is usually known before "what does it
 * speak", and it keeps a long candidate list readable.
 */
export type ProtocolFamily = 'lab' | 'monitor' | 'imaging' | 'interop' | 'industrial' | 'transport' | 'generic';

export const FAMILY_LABELS: Record<ProtocolFamily, string> = {
  lab: 'Laboratory analyzers (IVD)',
  monitor: 'Patient monitors, ventilators & point of care',
  imaging: 'Imaging & DICOM',
  interop: 'Hospital interoperability formats',
  industrial: 'Instrument & building buses',
  transport: 'Transport, session & link layers',
  generic: 'Generic shapes and fallbacks',
};

export interface ProtocolCandidate {
  /** Stable key, e.g. "astm-e1381". */
  id: string;
  /** What an operator would call it. */
  name: string;
  family: ProtocolFamily;
  /** 0..1 — how strongly the capture matches. */
  confidence: number;
  /** Concrete observations that produced the score; shown in the UI. */
  evidence: string[];
  /**
   * The `protocol` value to put in config.json when this connector already
   * implements it, or null when the capture is a protocol we recognise but do
   * not yet speak (a research port, a vendor binary, plain Modbus).
   */
  supported: string | null;
  /** Extra config keys this detector could infer, merged into the suggestion. */
  hints?: Record<string, unknown>;
}

interface Detector {
  id: string;
  name: string;
  family: ProtocolFamily;
  supported: string | null;
  /**
   * A shape rather than a protocol — "some delimited text", "some binary".
   * Suppressed once anything specific matches, so it never crowds a real hit.
   */
  fallback?: boolean;
  run(buf: Buffer, text: string): { score: number; evidence: string[]; hints?: Record<string, unknown> } | null;
}

const has = (buf: Buffer, byte: number) => buf.includes(byte);
const count = (buf: Buffer, byte: number) => {
  let n = 0;
  for (const b of buf) if (b === byte) n++;
  return n;
};
const printableRatio = (buf: Buffer) =>
  buf.length ? [...buf].filter((b) => b >= 0x20 && b <= 0x7e).length / buf.length : 0;

const hexHead = (buf: Buffer, n = 16) =>
  buf
    .subarray(0, n)
    .toString('hex')
    .toUpperCase()
    .replace(/(..)/g, '$1 ')
    .trim();

// -----------------------------------------------------------------------------
// Checksum helpers. A verified checksum is the strongest evidence any detector
// here can offer: vocabulary can coincide, arithmetic does not.
// -----------------------------------------------------------------------------

/**
 * ASTM E1381 modulo-256 checksum over the frame content, used to tell a real
 * ASTM frame from a stream that merely happens to contain STX.
 */
function astmChecksumOk(frame: Buffer): boolean {
  // frame is STX .. ETX/ETB C1 C2 CR LF — sum from after STX through ETX/ETB.
  // Counting back from the end: LF, CR, C2, C1, then the terminator itself.
  const end = frame.length - 5;
  if (end <= 1) return false;
  let sum = 0;
  for (let i = 1; i <= end; i++) sum = (sum + frame[i]!) & 0xff;
  const expect = sum.toString(16).toUpperCase().padStart(2, '0');
  const actual = String.fromCharCode(frame[end + 1]!, frame[end + 2]!).toUpperCase();
  return expect === actual;
}

/** CRC-16/MODBUS (reflected, poly 0xA001, init 0xFFFF) over buf[start,end). */
function crc16Modbus(buf: Buffer, start: number, end: number): number {
  let crc = 0xffff;
  for (let i = start; i < end; i++) {
    crc ^= buf[i]!;
    for (let b = 0; b < 8; b++) crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1;
  }
  return crc;
}

/** Split a capture into candidate E1381 frames (STX … CR LF). */
function astmFrames(buf: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  let i = 0;
  while (i < buf.length) {
    const stx = buf.indexOf(CTRL.STX, i);
    if (stx < 0) break;
    // The terminator is ETX or ETB, then two checksum digits, then CR LF.
    let end = -1;
    for (let j = stx + 1; j < buf.length - 4; j++) {
      if (buf[j] === CTRL.ETX || buf[j] === CTRL.ETB) {
        if (buf[j + 3] === CTRL.CR && buf[j + 4] === CTRL.LF) end = j + 4;
        break;
      }
    }
    if (end < 0) break;
    frames.push(buf.subarray(stx, end + 1));
    i = end + 1;
  }
  return frames;
}

/** ASTM E1394 record types, in the order a transmission uses them. */
// A record starts a line, or follows STX and the E1381 frame-number digit —
// missing that digit is the difference between reading a framed transmission
// and seeing nothing in it at all.
const ASTM_RECORDS = /(^|[\r\n\x02])[0-7]?([HPOQRCSLM])\|/g;

function astmRecordTypes(text: string): string[] {
  const seen: string[] = [];
  for (const m of text.matchAll(ASTM_RECORDS)) if (!seen.includes(m[2]!)) seen.push(m[2]!);
  return seen;
}

// =============================================================================
// The detectors
// =============================================================================

const DETECTORS: Detector[] = [
  // ---------------------------------------------------------------------------
  // Laboratory analyzers
  // ---------------------------------------------------------------------------
  {
    id: 'astm-e1381',
    name: 'ASTM E1381 / LIS1-A framing with E1394 records',
    family: 'lab',
    supported: 'astm',
    run(buf, text) {
      const frames = astmFrames(buf);
      const enq = count(buf, CTRL.ENQ);
      const recs = astmRecordTypes(text);
      if (!frames.length && !enq) return null;

      const good = frames.filter(astmChecksumOk).length;
      const evidence: string[] = [];
      let score = 0;

      if (enq) {
        evidence.push(`${enq} × ENQ — the E1381 establishment phase`);
        score += 0.2;
      }
      if (has(buf, CTRL.EOT)) {
        evidence.push('EOT present — the link is released the E1381 way');
        score += 0.1;
      }
      if (frames.length) {
        evidence.push(`${frames.length} STX…ETX/ETB frame(s) terminated with CR LF`);
        score += 0.25;
      }
      if (good) {
        // A verified modulo-256 checksum is not something a non-ASTM stream
        // produces by accident — this is the decisive signal.
        evidence.push(`${good}/${frames.length} frame checksum(s) verified (modulo-256)`);
        score += 0.4;
      }
      if (frames.some((f) => f[f.length - 5] === CTRL.ETB)) {
        evidence.push('ETB seen — records are split across intermediate frames');
      }
      if (recs.length) {
        evidence.push(`E1394 record types seen: ${recs.join(' ')}`);
        score += Math.min(0.25, recs.length * 0.06);
      }
      const hints: Record<string, unknown> = {};
      const h = /(^|[\r\n\x02])[0-7]?H\|([^|]*)\|/.exec(text);
      if (h?.[2]) {
        hints.delimiters = h[2];
        evidence.push(`delimiter definition in the H record: ${h[2]}`);
      }
      // LIS2-A2 and E1394-97 are the two version strings vendors put in H-12.
      const ver = /\|(LIS2-A2|E1394-97|LIS02-A2)\|/.exec(text);
      if (ver) evidence.push(`H record declares ${ver[1]}`);
      const frameMax = frames.reduce((m, f) => Math.max(m, f.length), 0);
      if (frameMax) hints.observedMaxFrameBytes = frameMax;
      return { score: Math.min(1, score), evidence, hints };
    },
  },

  {
    id: 'astm-raw-records',
    name: 'ASTM E1394 records, unframed (SOH…EOT stream)',
    family: 'lab',
    supported: 'abl9',
    run(buf, text) {
      const recs = astmRecordTypes(text);
      if (!recs.length) return null;
      // The distinguishing feature is E1394 records with NO E1381 framing —
      // the Radiometer ABL9 opens with SOH and closes with EOT and never sends
      // a checksummed frame at all.
      if (astmFrames(buf).length) return null;
      const evidence: string[] = [
        `E1394 record types seen: ${recs.join(' ')}`,
        'no STX…ETX framing anywhere in the capture',
      ];
      let score = 0.45;
      if (has(buf, CTRL.SOH)) {
        evidence.push('records are introduced by SOH');
        score += 0.25;
      }
      if (has(buf, CTRL.EOT)) {
        evidence.push('transmission terminated by EOT');
        score += 0.2;
      }
      if (!has(buf, CTRL.ENQ)) {
        evidence.push('no ENQ handshake — the device transmits unsolicited');
        score += 0.1;
      }
      return { score: Math.min(1, score), evidence };
    },
  },

  {
    id: 'hl7-v2',
    name: 'HL7 v2 (MLLP-framed, or raw)',
    family: 'lab',
    supported: 'hl7',
    run(buf, text) {
      const msh = text.includes('MSH|');
      const vt = count(buf, CTRL.VT);
      const fs = count(buf, CTRL.FS);
      if (!msh && !(vt && fs)) return null;
      const evidence: string[] = [];
      let score = 0;
      if (vt && fs) {
        evidence.push(`${vt} × VT / ${fs} × FS — MLLP block framing`);
        score += 0.45;
      } else if (msh) {
        // Worth calling out: the same messages arrive unframed when a device
        // drops files or writes to a serial port, and the codec must be told.
        evidence.push('HL7 segments with NO MLLP framing — file drop or serial delivery');
        score += 0.15;
      }
      if (msh) {
        evidence.push('MSH segment header present');
        score += 0.35;
      }
      const segs = [...new Set([...text.matchAll(/(?:^|[\r\n])([A-Z][A-Z0-9]{2})\|/g)].map((m) => m[1]!))];
      if (segs.length > 1) {
        evidence.push(`HL7 segments: ${segs.join(' ')}`);
        score += Math.min(0.2, segs.length * 0.03);
      }
      const hints: Record<string, unknown> = {};
      const mshLine = /MSH\|[^|]*\|([^|]*)\|([^|]*)\|/.exec(text);
      if (mshLine) {
        hints.sendingApp = mshLine[1] || undefined;
        hints.sendingFacility = mshLine[2] || undefined;
      }
      const type = /\|(ORU|ORM|OUL|QRY|ACK|OML|ADT)\^([A-Z0-9]+)/.exec(text);
      if (type) evidence.push(`message type ${type[1]}^${type[2]}`);
      const ver = /\|(2\.[0-9](?:\.[0-9])?)\|?/.exec(text);
      if (ver) {
        evidence.push(`HL7 version field reads ${ver[1]}`);
        hints.hl7Version = ver[1];
      }
      if (/MSH\|\^~\\&\|/.test(text)) evidence.push('standard encoding characters ^~\\&');
      return { score: Math.min(1, score), evidence, hints };
    },
  },

  {
    id: 'kermit',
    name: 'Kermit file transfer (VITROS 250/350 sample programs)',
    family: 'lab',
    supported: 'kermit',
    run(buf) {
      // A Kermit packet is SOH, a printable length, a printable sequence, then
      // a one-letter type from a small alphabet. Two consecutive well-formed
      // packets is far past coincidence.
      let packets = 0;
      const types = new Set<string>();
      for (let i = 0; i < buf.length - 3; i++) {
        if (buf[i] !== CTRL.SOH) continue;
        const len = buf[i + 1]! - 32;
        const seq = buf[i + 2]! - 32;
        const type = String.fromCharCode(buf[i + 3]!);
        if (len > 0 && len < 95 && seq >= 0 && seq < 64 && /[SFDZBEAYNRCGIQTX]/.test(type)) {
          packets++;
          types.add(type);
          i += Math.min(len, buf.length - i - 1);
        }
      }
      if (packets < 2) return null;
      const evidence = [
        `${packets} well-formed Kermit packets (SOH, printable LEN/SEQ, valid TYPE)`,
        `packet types seen: ${[...types].sort().join(' ')}`,
      ];
      let score = Math.min(0.85, 0.4 + packets * 0.05);
      if (types.has('S') && types.has('Z')) {
        evidence.push('Send-Init (S) and EOF (Z) both present — a complete transfer');
        score = Math.min(1, score + 0.15);
      }
      return { score, evidence };
    },
  },

  {
    id: 'advia2120i',
    name: 'Siemens ADVIA 2120i result framing',
    family: 'lab',
    supported: 'advia2120i',
    run(buf, text) {
      // The 2120i sends fixed-layout hematology blocks rather than E1394
      // records — STX framing but no H| header and no pipe-delimited records.
      const blocks = count(buf, CTRL.STX);
      if (!blocks) return null;
      if (astmRecordTypes(text).length) return null;
      if (printableRatio(buf) < 0.8) return null;
      const evidence: string[] = ['STX-framed blocks with no E1394 record header'];
      let score = 0.2;
      if (blocks > 2) {
        evidence.push(`${blocks} blocks in the capture`);
        score += 0.1;
      }
      const mnemonics = [...new Set(text.match(/\b(WBC|RBC|HGB|HCT|PLT|MCV|MCH|MCHC|RDW|MPV)\b/g) ?? [])];
      if (mnemonics.length >= 3) {
        // A lead, not proof: these mnemonics are shared by every hematology
        // analyzer ever built. It raises the ADVIA above the generic shapes,
        // and no further.
        evidence.push(`hematology mnemonics present: ${mnemonics.join(' ')}`);
        evidence.push('confirm against the ADVIA host-interface spec — these mnemonics are not vendor-unique');
        score += 0.35;
      }
      return { score: Math.min(1, score), evidence };
    },
  },

  {
    id: 'clinitek',
    name: 'Siemens CLINITEK Advantus urinalysis print stream',
    family: 'lab',
    supported: 'clinitek-advantus',
    run(_buf, text) {
      const hits = [...new Set(text.match(/\b(GLU|BIL|KET|SG|BLO|PH|PRO|URO|NIT|LEU)\b/g) ?? [])];
      if (hits.length < 4) return null;
      const evidence = [
        `urinalysis pad mnemonics present: ${hits.join(' ')}`,
        'line-oriented text with no E1394 or MLLP framing',
        'confirm against the CLINITEK spec — the pad names are common to urinalysis strips',
      ];
      return { score: Math.min(0.9, 0.3 + hits.length * 0.06), evidence };
    },
  },

  {
    id: 'poct1a',
    name: 'POCT1-A / POCT1-A2 (point-of-care device messaging)',
    family: 'monitor',
    supported: null,
    run(_buf, text) {
      if (!/<\?xml/i.test(text) && !/<(HELLO|OBS\.R0[12]|DEV\.|SVC\.|ACK\.)/i.test(text)) return null;
      const evidence: string[] = [];
      let score = 0;
      if (/<\?xml/i.test(text)) {
        evidence.push('XML declaration at the head of the stream');
        score += 0.25;
      }
      const topics = [...new Set(text.match(/<(HELLO|OBS\.R0[12]|DEV\.[A-Z.]*|SVC\.[A-Z.]*|ACK\.[A-Z.]*|EOT\.)/gi) ?? [])];
      if (topics.length) {
        evidence.push(`POCT1-A topic elements: ${topics.slice(0, 6).join(' ')}`);
        evidence.push('this is the CLSI POCT1-A device-to-observation-reviewer message set');
        score += 0.55;
      }
      if (/<ORU_R01|<MSH>|urn:hl7-org/i.test(text)) {
        evidence.push('HL7 v2.xml / v3 element names inside the document');
        score += 0.2;
      }
      return score > 0 ? { score: Math.min(1, score), evidence } : null;
    },
  },

  {
    id: 'hprim',
    name: 'HPRIM (French/EU laboratory interchange)',
    family: 'lab',
    supported: null,
    run(_buf, text) {
      // HPRIM Santé borrows ASTM's record letters but adds its own, and the
      // H record names the standard. Only claim it on that explicit marker —
      // otherwise it is indistinguishable from ASTM and would only add noise.
      if (!/\bHPRIM\b/i.test(text)) return null;
      return {
        score: 0.7,
        evidence: [
          'the header names HPRIM explicitly',
          'record layout is ASTM-like but the field map differs — read the HPRIM table, not E1394',
        ],
      };
    },
  },

  // ---------------------------------------------------------------------------
  // Patient monitors, ventilators, point of care
  // ---------------------------------------------------------------------------
  {
    id: 'ieee11073-phd',
    name: 'IEEE 11073-20601 (Personal Health Device APDU)',
    family: 'monitor',
    supported: null,
    run(buf) {
      if (buf.length < 4) return null;
      // An APDU is a 2-byte CHOICE tag then a 2-byte length. The tags are a
      // small, high-valued set, and the length must agree with the buffer.
      const tags: Record<number, string> = {
        0xe200: 'AARQ (association request)',
        0xe300: 'AARE (association response)',
        0xe400: 'RLRQ (release request)',
        0xe500: 'RLRE (release response)',
        0xe600: 'ABRT (abort)',
        0xe700: 'PRST (presentation / data report)',
      };
      const tag = buf.readUInt16BE(0);
      const name = tags[tag];
      if (!name) return null;
      const len = buf.readUInt16BE(2);
      const evidence = [`APDU tag 0x${tag.toString(16).toUpperCase()} — ${name}`];
      let score = 0.5;
      if (len + 4 === buf.length) {
        evidence.push(`declared length ${len} matches the capture exactly`);
        score += 0.25;
      } else if (len > 0 && len + 4 <= buf.length + 64) {
        evidence.push(`declared length ${len} is consistent with the capture`);
        score += 0.1;
      }
      // The association request carries the data protocol id: 20601 = 0x5079.
      if (tag === 0xe200 && buf.includes(Buffer.from([0x50, 0x79]))) {
        evidence.push('data-proto-id 20601 (0x5079) present — this is the -20601 optimized exchange protocol');
        score += 0.25;
      }
      return { score: Math.min(1, score), evidence };
    },
  },

  {
    id: 'vendor-ascii-framed',
    name: 'Vendor ASCII frame with checksum (ventilator / monitor class)',
    family: 'monitor',
    supported: null,
    run(buf, text) {
      // The shape shared by Dräger MEDIBUS, Nihon Kohden, Spacelabs Flexport
      // and most ventilator serial links: a control character opens the frame,
      // printable ASCII carries the payload, two hex digits close it, CR ends
      // it. We can verify the arithmetic without knowing the vendor — and that
      // is exactly the useful thing to report.
      const frames: { body: Buffer; sum: string }[] = [];
      for (let i = 0; i < buf.length; i++) {
        const open = buf[i]!;
        if (open !== CTRL.SOH && open !== CTRL.STX && open !== CTRL.ESC) continue;
        const cr = buf.indexOf(CTRL.CR, i + 1);
        if (cr < i + 4 || cr - i > 512) continue;
        const sum = buf.subarray(cr - 2, cr).toString('latin1');
        if (!/^[0-9A-Fa-f]{2}$/.test(sum)) continue;
        frames.push({ body: buf.subarray(i + 1, cr - 2), sum });
        i = cr;
      }
      if (!frames.length) return null;

      // Try the two conventions these protocols actually use: the sum over the
      // payload with, and without, the opening control character.
      let verified = 0;
      for (const f of frames) {
        let s = 0;
        for (const b of f.body) s = (s + b) & 0xff;
        const withOpen = (s + CTRL.SOH) & 0xff;
        const asHex = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
        if (asHex(s) === f.sum.toUpperCase() || asHex(withOpen) === f.sum.toUpperCase()) verified++;
      }
      if (!verified && frames.length < 3) return null;

      const evidence = [`${frames.length} control-opened ASCII frame(s) ending in two hex digits and CR`];
      let score = 0.3;
      if (verified) {
        evidence.push(`${verified}/${frames.length} frame checksum(s) verified as a modulo-256 sum`);
        score += 0.4;
      } else {
        evidence.push('the trailing hex digits did not verify as a plain modulo-256 sum — the vendor uses a variant');
      }
      if (printableRatio(buf) > 0.85) {
        evidence.push(`${Math.round(printableRatio(buf) * 100)}% printable — an ASCII command/response protocol`);
        score += 0.1;
      }
      evidence.push(
        'this is the Dräger MEDIBUS / Nihon Kohden / Spacelabs frame shape — identify the vendor from the device label, then read its command table',
      );
      const codes = [...new Set(text.match(/[\x01\x02\x1b]([A-Za-z])/g) ?? [])].map((s) => s.slice(1));
      if (codes.length) evidence.push(`command letters following the frame opener: ${codes.slice(0, 10).join(' ')}`);
      return { score: Math.min(0.85, score), evidence };
    },
  },

  // ---------------------------------------------------------------------------
  // Imaging
  // ---------------------------------------------------------------------------
  {
    id: 'dicom',
    name: 'DICOM (upper-layer PDU or part-10 stream)',
    family: 'imaging',
    supported: null,
    run(buf, text) {
      const evidence: string[] = [];
      let score = 0;
      if (text.includes('DICM')) {
        evidence.push('"DICM" magic present — a DICOM part-10 file or stream preamble');
        score += 0.7;
      }
      // The DICOM standard UID root appears in every association's context list.
      if (text.includes('1.2.840.10008')) {
        evidence.push('DICOM UID root 1.2.840.10008 present (transfer/SOP class context)');
        score += 0.35;
      }
      const pdu: Record<number, string> = {
        0x01: 'A-ASSOCIATE-RQ',
        0x02: 'A-ASSOCIATE-AC',
        0x03: 'A-ASSOCIATE-RJ',
        0x04: 'P-DATA-TF',
        0x05: 'A-RELEASE-RQ',
        0x06: 'A-RELEASE-RP',
        0x07: 'A-ABORT',
      };
      if (buf.length > 6 && buf[1] === 0x00 && pdu[buf[0]!]) {
        const len = buf.readUInt32BE(2);
        if (len > 0 && len < buf.length + 65536) {
          evidence.push(`PDU type 0x0${buf[0]!.toString(16)} (${pdu[buf[0]!]}) with a plausible length field (${len})`);
          score += 0.5;
        }
      }
      return score > 0 ? { score: Math.min(1, score), evidence } : null;
    },
  },

  // ---------------------------------------------------------------------------
  // Hospital interoperability formats
  // ---------------------------------------------------------------------------
  {
    id: 'fhir',
    name: 'HL7 FHIR resource (JSON or XML)',
    family: 'interop',
    supported: null,
    run(_buf, text) {
      const json = /"resourceType"\s*:\s*"([A-Za-z]+)"/.exec(text);
      const xml = /<([A-Za-z]+)\s+xmlns\s*=\s*"http:\/\/hl7\.org\/fhir"/.exec(text);
      if (!json && !xml) return null;
      const resource = json?.[1] ?? xml?.[1] ?? 'unknown';
      const evidence = [
        json ? `JSON resource with resourceType "${resource}"` : `XML resource <${resource}> in the FHIR namespace`,
      ];
      if (/"(Observation|DiagnosticReport|Specimen|Device|ServiceRequest)"/.test(text)) {
        evidence.push('carries laboratory resources (Observation / DiagnosticReport / Specimen)');
      }
      evidence.push('a FHIR endpoint is a REST API — it needs an HTTP client, not a wire codec');
      return { score: 0.85, evidence };
    },
  },

  {
    id: 'hl7-v3-cda',
    name: 'HL7 v3 / CDA document',
    family: 'interop',
    supported: null,
    run(_buf, text) {
      if (!/<ClinicalDocument|urn:hl7-org:v3/i.test(text)) return null;
      const evidence: string[] = [];
      if (/<ClinicalDocument/i.test(text)) evidence.push('<ClinicalDocument> root — a CDA document');
      if (/urn:hl7-org:v3/i.test(text)) evidence.push('the HL7 v3 namespace urn:hl7-org:v3 is declared');
      return { score: 0.85, evidence };
    },
  },

  // ---------------------------------------------------------------------------
  // Instrument and building buses
  // ---------------------------------------------------------------------------
  {
    id: 'modbus-tcp',
    name: 'Modbus/TCP',
    family: 'industrial',
    supported: null,
    run(buf) {
      // MBAP header: 2-byte txn, protocol id 0x0000, length, unit id, function.
      if (buf.length < 8) return null;
      if (buf.readUInt16BE(2) !== 0) return null;
      const len = buf.readUInt16BE(4);
      const fn = buf[7]!;
      if (len < 2 || len > 260) return null;
      if (!(fn >= 1 && fn <= 43)) return null;
      const evidence = [
        'MBAP header: protocol identifier 0x0000',
        `declared length ${len}, unit id ${buf[6]}, function code ${fn}`,
      ];
      let score = 0.55;
      if (len + 6 === buf.length) {
        evidence.push('the declared length matches the capture exactly');
        score += 0.2;
      }
      evidence.push('a register map, not a message format — the device vendor must supply it');
      return { score: Math.min(1, score), evidence };
    },
  },

  {
    id: 'modbus-rtu',
    name: 'Modbus RTU (serial)',
    family: 'industrial',
    supported: null,
    run(buf) {
      if (buf.length < 5) return null;
      // Walk the buffer looking for frames whose trailing CRC-16 actually
      // verifies. Nothing but a real Modbus frame does that twice.
      let frames = 0;
      let at = 0;
      const fns = new Set<number>();
      while (at < buf.length - 4 && frames < 64) {
        let matched = 0;
        for (let len = 4; len <= Math.min(256, buf.length - at); len++) {
          const crc = crc16Modbus(buf, at, at + len - 2);
          if ((crc & 0xff) === buf[at + len - 2] && (crc >> 8) === buf[at + len - 1]) {
            const fn = buf[at + 1]!;
            if (fn >= 1 && fn <= 43) {
              matched = len;
              fns.add(fn);
              break;
            }
          }
        }
        if (!matched) break;
        frames++;
        at += matched;
      }
      if (frames < 1) return null;
      const evidence = [
        `${frames} frame(s) with a VERIFIED CRC-16/MODBUS trailer`,
        `function codes seen: ${[...fns].sort((a, b) => a - b).join(' ')}`,
      ];
      // One verified CRC could in principle be luck; two cannot.
      const score = frames === 1 ? 0.55 : Math.min(0.95, 0.6 + frames * 0.1);
      if (frames > 1) evidence.push('consecutive verified frames — this is Modbus RTU, not a coincidence');
      evidence.push('a register map, not a message format — the device vendor must supply it');
      return { score, evidence };
    },
  },

  {
    id: 'bacnet-ip',
    name: 'BACnet/IP (building & medical gas plant)',
    family: 'industrial',
    supported: null,
    run(buf) {
      if (buf.length < 4) return null;
      if (buf[0] !== 0x81) return null; // BVLC type: BACnet/IP
      const fn = buf[1]!;
      if (fn > 0x0b) return null;
      const len = buf.readUInt16BE(2);
      if (len < 4 || len > 1500) return null;
      const evidence = [`BVLC header 0x81, function 0x${fn.toString(16).padStart(2, '0')}, length ${len}`];
      let score = 0.55;
      if (len === buf.length) {
        evidence.push('the declared length matches the capture exactly');
        score += 0.25;
      }
      return { score: Math.min(1, score), evidence };
    },
  },

  {
    id: 'opcua',
    name: 'OPC UA binary (modern instrument control)',
    family: 'industrial',
    supported: null,
    run(buf, text) {
      if (buf.length < 8) return null;
      const magic = text.slice(0, 4);
      if (!/^(HEL|ACK|ERR|OPN|CLO|MSG|RHE)[FCA]$/.test(magic)) return null;
      const len = buf.readUInt32LE(4);
      if (len < 8 || len > 16 * 1024 * 1024) return null;
      const evidence = [`OPC UA message type "${magic}" with a 32-bit little-endian length of ${len}`];
      let score = 0.7;
      if (len === buf.length) {
        evidence.push('the declared length matches the capture exactly');
        score += 0.2;
      }
      return { score: Math.min(1, score), evidence };
    },
  },

  {
    id: 'mqtt',
    name: 'MQTT (networked device telemetry)',
    family: 'industrial',
    supported: null,
    run(buf) {
      if (buf.length < 8) return null;
      if (buf[0]! >> 4 !== 1) return null; // CONNECT
      // Remaining-length is a varint of up to four bytes.
      let at = 1;
      let mult = 1;
      let remaining = 0;
      for (let i = 0; i < 4 && at < buf.length; i++) {
        const b = buf[at++]!;
        remaining += (b & 0x7f) * mult;
        mult *= 128;
        if (!(b & 0x80)) break;
      }
      if (remaining < 6 || at + 6 > buf.length) return null;
      const nameLen = buf.readUInt16BE(at);
      const name = buf.subarray(at + 2, at + 2 + nameLen).toString('latin1');
      if (name !== 'MQTT' && name !== 'MQIsdp') return null;
      return {
        score: 0.9,
        evidence: [
          `MQTT CONNECT packet, protocol name "${name}"`,
          `remaining length ${remaining}, protocol level ${buf[at + 2 + nameLen] ?? '?'}`,
          'the device publishes to a broker — subscribe to its topics rather than framing bytes',
        ],
      };
    },
  },

  {
    id: 'snmp',
    name: 'SNMP (device health / management plane)',
    family: 'industrial',
    supported: null,
    run(buf) {
      if (buf.length < 8) return null;
      if (buf[0] !== 0x30) return null; // ASN.1 SEQUENCE
      // Skip the BER length (short or long form), then expect INTEGER version.
      let at = 1;
      const first = buf[at++]!;
      if (first & 0x80) at += first & 0x7f;
      if (at + 2 >= buf.length) return null;
      if (buf[at] !== 0x02 || buf[at + 1] !== 0x01) return null;
      const version = buf[at + 2]!;
      if (![0, 1, 3].includes(version)) return null;
      const label = { 0: 'v1', 1: 'v2c', 3: 'v3' }[version as 0 | 1 | 3];
      return {
        score: 0.7,
        evidence: [
          `ASN.1 BER SEQUENCE opening an SNMP ${label} message`,
          'this is the management plane, not the result interface — look for a separate data port',
        ],
      };
    },
  },

  // ---------------------------------------------------------------------------
  // Transport, session and link layers
  // ---------------------------------------------------------------------------
  {
    id: 'tls',
    name: 'TLS / SSL record layer',
    family: 'transport',
    supported: null,
    run(buf) {
      if (buf.length < 6) return null;
      const type = buf[0]!;
      if (![0x14, 0x15, 0x16, 0x17].includes(type)) return null;
      if (buf[1] !== 0x03 || buf[2]! > 0x04) return null;
      const len = buf.readUInt16BE(3);
      if (len < 1 || len > 16640) return null;
      const evidence = [
        `TLS record: type 0x${type.toString(16)}, version 3.${buf[2]}, length ${len}`,
      ];
      if (type === 0x16 && buf[5] === 0x01) evidence.push('handshake byte 0x01 — a ClientHello');
      if (type === 0x16 && buf[5] === 0x02) evidence.push('handshake byte 0x02 — a ServerHello');
      // The single most useful finding this tool can produce on a silent port.
      evidence.push('THE PORT IS ENCRYPTED — a raw probe will never see plaintext here');
      evidence.push('the device needs a TLS client, and probably a certificate; check its network/security settings');
      return { score: 0.9, evidence };
    },
  },

  {
    id: 'telnet',
    name: 'Telnet option negotiation (terminal server not in raw mode)',
    family: 'transport',
    supported: null,
    run(buf) {
      let negotiations = 0;
      for (let i = 0; i < buf.length - 2; i++) {
        if (buf[i] === 0xff && buf[i + 1]! >= 0xfb && buf[i + 1]! <= 0xfe) negotiations++;
      }
      if (negotiations < 2) return null;
      return {
        score: Math.min(0.85, 0.4 + negotiations * 0.1),
        evidence: [
          `${negotiations} IAC WILL/WONT/DO/DONT sequences`,
          'the terminal server is in telnet mode, so it will inject option bytes into the analyzer stream',
          'switch that port to RAW/TCP mode on the device server, or the codec will see corrupt frames',
        ],
      };
    },
  },

  {
    id: 'xmodem',
    name: 'XMODEM / YMODEM block transfer',
    family: 'transport',
    supported: null,
    run(buf) {
      // A block is SOH (128 bytes) or STX (1024 bytes), the block number, then
      // its ones-complement. That complement is the whole signal.
      let blocks = 0;
      let k = false;
      for (let i = 0; i < buf.length - 3; i++) {
        const open = buf[i]!;
        if (open !== CTRL.SOH && open !== CTRL.STX) continue;
        const blk = buf[i + 1]!;
        if (buf[i + 2] !== (255 - blk & 0xff)) continue;
        blocks++;
        if (open === CTRL.STX) k = true;
        i += open === CTRL.STX ? 1028 : 132;
      }
      if (blocks < 1) return null;
      return {
        score: blocks === 1 ? 0.5 : Math.min(0.9, 0.55 + blocks * 0.1),
        evidence: [
          `${blocks} block header(s) with a valid ones-complement block number`,
          k ? 'STX blocks — 1024-byte YMODEM/XMODEM-1K' : 'SOH blocks — 128-byte XMODEM',
          'the device is transferring a FILE; capture it whole, then parse the file, not the link',
        ],
      };
    },
  },

  {
    id: 'service-banner',
    name: 'Standard network service (FTP / SSH / SMTP / POP3)',
    family: 'transport',
    supported: null,
    run(_buf, text) {
      const rules: [RegExp, string][] = [
        [/^SSH-\d\.\d/, 'SSH — a shell, not a data port'],
        [/^220[ -].*(FTP|FileZilla|vsFTPd|ProFTPD)/i, 'FTP — the device probably EXPORTS RESULT FILES here'],
        [/^220[ -].*SMTP/i, 'SMTP — the device emails results'],
        [/^220[ -]/, 'FTP or SMTP greeting'],
        [/^\+OK/, 'POP3'],
        [/^\* OK/, 'IMAP'],
      ];
      for (const [re, what] of rules) {
        if (re.test(text)) {
          return {
            score: 0.8,
            evidence: [`service greeting: ${text.split(/\r?\n/)[0]!.slice(0, 80)}`, what],
          };
        }
      }
      return null;
    },
  },

  {
    id: 'http',
    name: 'HTTP (device web service or REST hook)',
    family: 'transport',
    supported: null,
    run(_buf, text) {
      if (!/^(GET|POST|PUT|DELETE|HEAD|OPTIONS) \S+ HTTP\/1\.[01]\r?\n/.test(text) && !/^HTTP\/1\.[01] \d{3}/.test(text)) {
        return null;
      }
      const evidence = ['HTTP request or status line at the head of the stream'];
      const ct = /content-type:\s*([^\r\n]+)/i.exec(text);
      if (ct) evidence.push(`Content-Type: ${ct[1]!.trim()}`);
      const server = /server:\s*([^\r\n]+)/i.exec(text);
      if (server) evidence.push(`Server: ${server[1]!.trim()}`);
      return { score: 0.9, evidence };
    },
  },

  {
    id: 'syslog',
    name: 'Syslog (device event stream)',
    family: 'transport',
    supported: null,
    run(_buf, text) {
      const m = /^<(\d{1,3})>/.exec(text);
      if (!m) return null;
      const pri = Number(m[1]);
      if (pri > 191) return null;
      return {
        score: 0.75,
        evidence: [
          `RFC 3164/5424 priority <${pri}> (facility ${pri >> 3}, severity ${pri & 7})`,
          'an event log, not a result feed — useful for diagnosing the device, not for interfacing it',
        ],
      };
    },
  },

  // ---------------------------------------------------------------------------
  // Print streams — an analyzer with no LIS port often still has a printer port
  // ---------------------------------------------------------------------------
  {
    id: 'print-stream',
    name: 'Printer control language (ZPL / ESC-P / PCL)',
    family: 'generic',
    supported: null,
    run(buf, text) {
      const evidence: string[] = [];
      let score = 0;
      if (/\^XA/.test(text) && /\^XZ/.test(text)) {
        evidence.push('ZPL label format between ^XA and ^XZ');
        score += 0.75;
      }
      if (buf[0] === CTRL.ESC && buf[1] === 0x40) {
        evidence.push('ESC @ — the ESC/P printer reset sequence');
        score += 0.6;
      }
      if (buf[0] === CTRL.ESC && (buf[1] === 0x45 || buf[1] === 0x26)) {
        evidence.push('ESC E / ESC & — an HP PCL job');
        score += 0.6;
      }
      if (!score) return null;
      evidence.push(
        'the device is PRINTING its results — capture the print stream and parse the report layout; there may be no LIS port at all',
      );
      return { score: Math.min(0.95, score), evidence };
    },
  },

  // ---------------------------------------------------------------------------
  // Generic shapes. These are suppressed as soon as anything specific matches.
  // ---------------------------------------------------------------------------
  {
    id: 'json',
    name: 'JSON payload (modern device API)',
    family: 'generic',
    supported: null,
    run(_buf, text) {
      const t = text.trim();
      if (!/^[[{]/.test(t)) return null;
      try {
        JSON.parse(t);
        return { score: 0.85, evidence: ['the whole capture parses as a single JSON document'] };
      } catch {
        return /"[a-zA-Z_]+"\s*:/.test(t)
          ? { score: 0.4, evidence: ['JSON-shaped key/value text, but the capture is not a complete document'] }
          : null;
      }
    },
  },

  {
    id: 'xml-generic',
    name: 'XML document (unrecognised schema)',
    family: 'generic',
    supported: null,
    fallback: true,
    run(_buf, text) {
      if (!/^\s*<\?xml|^\s*<[A-Za-z]/.test(text)) return null;
      const root = /<([A-Za-z][\w.:-]*)[\s>]/.exec(text);
      const ns = /xmlns\s*=\s*"([^"]+)"/.exec(text);
      const evidence = [root ? `root element <${root[1]}>` : 'XML-shaped markup'];
      if (ns) evidence.push(`namespace ${ns[1]}`);
      evidence.push('no known medical schema matched — check the namespace against the vendor documentation');
      return { score: 0.4, evidence };
    },
  },

  {
    id: 'delimited-text',
    name: 'Delimited or fixed-width text (proprietary print/export format)',
    family: 'generic',
    supported: null,
    fallback: true,
    run(buf, text) {
      const printable = [...buf].filter((b) => (b >= 0x20 && b <= 0x7e) || b === 0x0a || b === 0x0d || b === 0x09).length;
      if (!buf.length || printable / buf.length < 0.9) return null;
      const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim());
      if (lines.length < 2) return null;
      const evidence: string[] = [`${Math.round((printable / buf.length) * 100)}% printable, ${lines.length} lines`];
      let score = 0.2;
      for (const [name, ch] of [['comma', ','], ['tab', '\t'], ['semicolon', ';'], ['pipe', '|'], ['caret', '^']] as const) {
        const per = lines.map((l) => l.split(ch).length - 1);
        const first = per[0]!;
        if (first > 1 && per.every((n) => n === first)) {
          evidence.push(`every line has exactly ${first} ${name} separators — a consistent record layout`);
          score += 0.35;
          break;
        }
      }
      const widths = new Set(lines.map((l) => l.length));
      if (widths.size === 1 && lines.length > 2) {
        evidence.push(`all ${lines.length} lines are exactly ${[...widths][0]} characters — fixed width`);
        score += 0.3;
      }
      return { score: Math.min(0.75, score), evidence };
    },
  },

  {
    id: 'binary-unknown',
    name: 'Unrecognised binary (vendor-proprietary)',
    family: 'generic',
    supported: null,
    fallback: true,
    run(buf) {
      if (!buf.length) return null;
      const ratio = printableRatio(buf);
      if (ratio > 0.7) return null;
      // Report the leading bytes: a vendor magic number is the fastest route to
      // an answer once someone has the interface spec in hand.
      return {
        score: 0.3,
        evidence: [
          `only ${Math.round(ratio * 100)}% printable — this is a binary framing`,
          `first bytes: ${hexHead(buf)}`,
          'compare the leading bytes against the vendor host-interface specification',
        ],
      };
    },
  },
];

// =============================================================================
// Public API
// =============================================================================

export interface IdentifyResult {
  bytes: number;
  candidates: ProtocolCandidate[];
  /** Byte-level facts the operator may want even when nothing scores well. */
  observations: string[];
  /** A ready-to-paste config.json analyzer block for the top supported hit. */
  suggestion: Record<string, unknown> | null;
}

/** Anything at or above this counts as a real identification, not a shape. */
const SPECIFIC_ENOUGH = 0.6;

/**
 * Rank the capture against every detector. Runs all of them — a stream that
 * scores on two protocols (E1394 records inside a Kermit transfer, say) is a
 * real and useful answer, so nothing short-circuits.
 */
export function identify(buf: Buffer, opts: { transport?: Record<string, unknown> } = {}): IdentifyResult {
  const text = buf.toString('latin1');
  const candidates: ProtocolCandidate[] = [];

  for (const d of DETECTORS) {
    let hit;
    try {
      hit = d.run(buf, text);
    } catch {
      // A detector must never take the analysis down — a malformed capture is
      // exactly the case this tool exists for.
      continue;
    }
    if (!hit || hit.score <= 0) continue;
    candidates.push({
      id: d.id,
      name: d.name,
      family: d.family,
      confidence: Math.round(hit.score * 100) / 100,
      evidence: hit.evidence,
      supported: d.supported,
      hints: hit.hints,
    });
  }

  // Once something specific has matched, "it is some delimited text" adds
  // nothing but noise, so drop the shape detectors.
  const identified = candidates.some(
    (c) => c.confidence >= SPECIFIC_ENOUGH && !DETECTORS.find((d) => d.id === c.id)?.fallback,
  );
  const ranked = (identified ? candidates.filter((c) => !DETECTORS.find((d) => d.id === c.id)?.fallback) : candidates).sort(
    (a, b) => b.confidence - a.confidence,
  );

  const top = ranked.find((c) => c.supported);
  return {
    bytes: buf.length,
    candidates: ranked,
    observations: observe(buf, text),
    suggestion: top ? buildSuggestion(top, opts.transport) : null,
  };
}

/** Byte-level facts that hold whatever the protocol turns out to be. */
function observe(buf: Buffer, text: string): string[] {
  const out: string[] = [];
  if (!buf.length) return ['nothing captured yet — the device has not transmitted'];

  const ratio = printableRatio(buf);
  out.push(`${buf.length} bytes, ${Math.round(ratio * 100)}% printable ASCII`);

  const ctrls = [...new Set([...buf].filter((b) => b < 0x20 || b === 0x7f))]
    .sort((a, b) => a - b)
    .map((b) => CTRL_NAME[b] ?? `0x${b.toString(16).padStart(2, '0')}`);
  if (ctrls.length) out.push(`control characters present: ${ctrls.join(' ')}`);

  const high = [...buf].filter((b) => b > 0x7f).length;
  if (high) {
    // The classic serial commissioning trap: the port is open at 8-N-1 but the
    // device is sending 7 data bits plus a parity bit, so every byte arrives
    // with its top bit set and the text looks like garbage. Masking it off is
    // a one-line test that saves an afternoon.
    const masked = Buffer.from([...buf].map((b) => b & 0x7f));
    if (ratio < 0.7 && printableRatio(masked) > 0.9) {
      out.push(
        'clearing the high bit of every byte turns this into clean text — the device is sending 7 data bits with a PARITY bit; reopen the port as 7-E-1 (or 7-O-1)',
      );
    } else {
      out.push(`${high} bytes above 0x7F — 8-bit data, or a non-ASCII character set`);
    }
  }

  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) out.push('UTF-8 byte-order mark at the head');
  if ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff)) {
    out.push('UTF-16 byte-order mark — the payload is 16-bit text, not bytes');
  }
  if (buf[0] === 0x1f && buf[1] === 0x8b) out.push('gzip magic — the payload is compressed');
  if (text.startsWith('PK\x03\x04')) out.push('ZIP magic — the payload is an archive');

  if (has(buf, CTRL.XON) || has(buf, CTRL.XOFF)) {
    out.push('XON/XOFF present — the link uses software flow control; the codec must not treat these as data');
  }
  if (has(buf, CTRL.NAK)) out.push('NAK present — the peer rejected at least one frame; expect retransmissions');

  const crlf = /\r\n/.test(text);
  const bareCr = /\r(?!\n)/.test(text);
  const bareLf = /(?<!\r)\n/.test(text);
  const eol = [crlf && 'CR LF', bareCr && 'bare CR', bareLf && 'bare LF'].filter(Boolean);
  if (eol.length) out.push(`line endings: ${eol.join(', ')}`);

  const delims = ['|', '^', '~', '\\', '&', ',', '\t', ';'].filter((d) => text.includes(d));
  if (delims.length) out.push(`candidate field delimiters seen: ${delims.map((d) => (d === '\t' ? 'TAB' : d)).join(' ')}`);

  return out;
}

/**
 * Turn the winning candidate into an analyzer block the operator can paste
 * straight into config.json. Only the keys we actually inferred are filled —
 * the rest stay at their schema defaults rather than being guessed.
 */
function buildSuggestion(top: ProtocolCandidate, transport?: Record<string, unknown>): Record<string, unknown> {
  const block: Record<string, unknown> = {
    id: 'new-analyzer',
    equipmentCode: 'CHANGE-ME',
    protocol: top.supported,
    transport: transport ?? { type: 'tcp', mode: 'server', host: '0.0.0.0', port: 5001 },
    sendDemographics: false,
    hostQuery: top.supported === 'astm',
    qc: { sampleIdPrefixes: ['QC', 'CTRL', 'CONTROL'] },
  };

  const h = top.hints ?? {};
  if (top.supported === 'astm') {
    block.astm = {
      senderId: 'HMIS-LIS',
      receiverId: 'LIS',
      ackTimeoutMs: 15000,
      frameMaxData: 240,
      // The dialect governs the ORDER DOWNLOAD layout only, which a capture of
      // the analyzer's own results cannot reveal. Left at the default on
      // purpose — it must come from the vendor's host-interface spec.
      dialect: 'atellica',
    };
  }
  if (top.supported === 'abl9') {
    block.abl9 = { ack: false };
    block.astm = { dialect: 'atellica' };
  }
  if (top.supported === 'hl7') {
    block.hl7 = {
      sendingApp: 'HMIS',
      sendingFacility: 'ZYDUS',
      ack: true,
      encoding: 'mllp',
    };
    if (h.hl7Version) (block.hl7 as Record<string, unknown>).version = h.hl7Version;
  }
  if (top.supported === 'kermit') {
    block.kermit = { ackTimeoutMs: 15000, maxRetries: 5, interPacketDelayMs: 0 };
  }
  return block;
}

/** Every protocol the fingerprinter knows about — surfaced in the UI. */
export function knownProtocols(): { id: string; name: string; family: ProtocolFamily; supported: string | null }[] {
  return DETECTORS.map((d) => ({ id: d.id, name: d.name, family: d.family, supported: d.supported }));
}
