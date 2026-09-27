import { devicesOf, type StagedSample } from './store.js';

// =============================================================================
// PAIRED-INSTRUMENT HOLD — the Sysmex U-WAM rule, and nothing else.
//
// The U-WAM is a work-area manager, not an analyzer. Behind it stand TWO
// instruments that share one urine tube: the UC-3500 reads the test strip
// (C-GLU, C-PRO, C-PH, C-COLOR …) and the UF-4000 counts the particles (RBC,
// WBC, EC, CAST, BACT …). HMIS holds them as one urine panel, so half a panel
// is half a report.
//
// The U-WAM does NOT always send both halves together. Measured on this site's
// own wire logs (logs/wire-sysmex-uwam-2026-09-17/18/19.log, 239 samples):
//
//   * 134 samples arrived with at least one message carrying both instruments;
//   * 60 arrived as one instrument first and the other in a separate message
//     later — 43 strip-first, 17 particles-first. The second half followed
//     within 30 seconds on 56 of those 60; the four stragglers took 10, 16,
//     34 and 51 minutes, which is the operator validating and the U-WAM
//     re-sending rather than the run itself;
//   * 91 samples only ever had one instrument, because a tube was run on one
//     of them or the other was out of service.
//
// Filing each half the moment it lands is what the lab sees as "partial data
// transfer": HMIS accepts the first half, flips the sample to "result
// interfaced", and the report goes out with the other instrument's rows blank.
//
// So a U-WAM sample is HELD until every instrument named in `devices` has
// reported at least one interfaced value for it, and then files in one pass.
//
// Whether the hold may expire is the site's call. A tube may legitimately be
// run on only one of the two instruments, and an instrument can be down for a
// day — on 2026-09-19, 69 of 81 samples had no strip half at all. `maxWaitMs`
// is the backstop: once it expires the sample files whatever it has, exactly
// as before, and says in the log which instrument never reported. Ten minutes
// covers 56 of the 60 measured splits several times over while capping what a
// single-instrument day costs the lab.
//
// `maxWaitMs: null` switches the backstop off: the sample waits until every
// instrument has reported, however long that takes, and only the console's
// "file now" releases it early. This lab asked for exactly that on 2026-09-19:
// HMIS must never show the urine panel as result-interfaced while one
// instrument's rows are still blank, even at the price of a tube run on one
// machine sitting in the queue until an operator files it by hand.
//
// This module is deliberately specific. Nothing else in the connector pairs
// instruments, because no other machine here fronts two of them: the gate is
// off (`devices` empty) for every analyzer whose config does not ask for it,
// and only the `sysmex-uwam` profile does.
// =============================================================================

export interface PairingRule {
  /** Instrument names, as the U-WAM spells them in ASTM R field 14
   *  ("UC-3500", "UF-4000"). Compared case-insensitively. Empty = no hold. */
  devices: string[];
  /** How long a sample may be held waiting for the instruments that have not
   *  reported. After this it files with whatever it has. `null` = no limit:
   *  the sample is held until every instrument has reported, and only the
   *  operator's "file now" releases it. */
  maxWaitMs: number | null;
}

export type PairingVerdict =
  | { hold: false; reason: null; missing: string[]; expired: boolean; remainingMs: 0 }
  | { hold: true; reason: string; missing: string[]; expired: false; remainingMs: number | null };

const NOT_HELD: PairingVerdict = { hold: false, reason: null, missing: [], expired: false, remainingMs: 0 };

/** The held sample's `lastError`. Deliberately free of a countdown: the filing
 *  pass says a thing once per change of state, and a reason that ticked every
 *  15 seconds would print a line every 15 seconds. The time left rides in the
 *  log's fields instead. */
export function holdReason(missing: string[]): string {
  return `waiting for ${missing.join(' and ')} on this tube before filing`;
}

/**
 * Should this sample wait for its other instrument?
 *
 * `now` and the sample's `firstReceivedAt` bound the wait when the rule has a
 * `maxWaitMs`; with `null` the wait is unbounded. A sample with no
 * instrument name on ANY value is never held: either the message did not carry
 * field 14 or the values predate this feature, and holding on absent evidence
 * would stall every sample for the full window.
 */
export function pairingVerdict(sample: StagedSample, rule: PairingRule | null, now = Date.now()): PairingVerdict {
  if (!rule || rule.devices.length === 0) return NOT_HELD;

  const seen = devicesOf(sample);
  // No instrument named anything at all — nothing to reason from.
  if (seen.size === 0) return NOT_HELD;

  const missing = rule.devices.filter((d) => !seen.has(d.trim().toUpperCase()));
  if (missing.length === 0) return NOT_HELD;

  // No backstop: held until the partner reports or the operator files it.
  if (rule.maxWaitMs === null) {
    return { hold: true, reason: holdReason(missing), missing, expired: false, remainingMs: null };
  }

  const waitedMs = now - Date.parse(sample.firstReceivedAt);
  // An unparseable timestamp must not mean "wait forever".
  if (!Number.isFinite(waitedMs) || waitedMs >= rule.maxWaitMs) {
    return { hold: false, reason: null, missing, expired: true, remainingMs: 0 };
  }

  return {
    hold: true,
    reason: holdReason(missing),
    missing,
    expired: false,
    remainingMs: rule.maxWaitMs - waitedMs,
  };
}

/** True when this sample's last filing pass held it for its partner
 *  instrument — how the pass knows it is crossing out of a hold and should say
 *  so once, rather than on every tick. */
export function wasHeld(lastError: string | null): boolean {
  return typeof lastError === 'string' && lastError.startsWith('waiting for ');
}
