// =============================================================================
// Barcode completion — the HMIS barcode from a short id keyed on the instrument.
//
// The Shela Erba H360 has no barcode reader in use. The operators key the
// sample on the instrument as "SF" plus the last four digits of the HMIS
// barcode — "sf0054" for SF2608290054 — or just the digits. The retired
// middleware completed those ids before posting (its Results log shows
// SF2608290054 and SF2608290057 filed on 2026-08-29 for tubes the H360 sent
// as sf0054 and sf0057), so the lab has never had to type the full 12
// characters. Every H360 result since this connector took over (2026-09-05)
// has waited unfiled under its short id — 59 barcodes, 0 filed.
//
// This does the same completion, but deterministically: the full barcode is
// BUILT from a site template — the sequence number the instrument sent, and
// the date the result was received — and is only used if HMIS has an order
// under exactly that barcode. There is no suffix search across cached orders,
// because "0002" exists on every day's list; a tube run after midnight, or a
// mistyped sequence, does not complete and waits for the operator to re-key
// it from the console instead. Staged filing only.
//
// Template tokens (from the result's received time, local clock):
//   {yyyy} {yy} {mm} {dd}      the date
//   {seq:N}                    the captured sequence, zero-padded to N digits
// =============================================================================

export interface BarcodeCompletionRule {
  /** Regex the instrument's id must match (case-insensitive, whole string),
   *  with ONE capture group: the sequence number. */
  short: string;
  /** The HMIS barcode built from it, e.g. "SF{yy}{mm}{dd}{seq:4}". */
  full: string;
}

const TOKEN = /\{(yyyy|yy|mm|dd|seq(?::(\d+))?)\}/g;

/** Validate a rule up front so a bad template fails at config load, not at
 *  the first result. Returns the compiled matcher. */
export function compileCompletion(rule: BarcodeCompletionRule): (short: string, receivedAt: Date) => string | null {
  const re = new RegExp(`^(?:${rule.short})$`, 'i'); // throws on a malformed pattern
  if (!/\((?!\?)/.test(rule.short)) {
    throw new Error(`barcodeCompletion.short needs one capture group for the sequence: ${rule.short}`);
  }
  if (!/\{seq(?::\d+)?\}/.test(rule.full)) {
    throw new Error(`barcodeCompletion.full must contain {seq} or {seq:N}: ${rule.full}`);
  }
  for (const m of rule.full.matchAll(/\{[^}]*\}/g)) {
    if (!/^\{(yyyy|yy|mm|dd|seq(?::\d+)?)\}$/.test(m[0])) {
      throw new Error(`barcodeCompletion.full: unknown token ${m[0]} (allowed: {yyyy} {yy} {mm} {dd} {seq:N})`);
    }
  }

  return (short: string, receivedAt: Date): string | null => {
    const m = re.exec((short ?? '').trim());
    if (!m || m[1] === undefined) return null;
    const seq = m[1];
    if (!/^\d+$/.test(seq)) return null;
    const yyyy = String(receivedAt.getFullYear());
    const mm = String(receivedAt.getMonth() + 1).padStart(2, '0');
    const dd = String(receivedAt.getDate()).padStart(2, '0');
    const out = rule.full.replace(TOKEN, (_all, tok: string, width?: string) => {
      switch (tok) {
        case 'yyyy':
          return yyyy;
        case 'yy':
          return yyyy.slice(-2);
        case 'mm':
          return mm;
        case 'dd':
          return dd;
        default: {
          const n = width ? Number(width) : 0;
          if (n && seq.length > n) return seq.slice(-n); // "0064" keyed as "00064"
          return n ? seq.padStart(n, '0') : seq;
        }
      }
    });
    return out.toUpperCase();
  };
}
