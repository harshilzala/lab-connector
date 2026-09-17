import type { EventEmitter } from 'node:events';
import type { OrderDownload, ParsedMessage, ProtocolName } from '../types.js';

// =============================================================================
// ProtocolLink = the protocol state machine (ASTM or HL7) bound to a transport.
// It turns inbound bytes into ParsedMessage events and can push order-downloads
// back to the analyzer. This is the pluggable seam: swap AstmLink ↔ Hl7Link
// without touching the orchestrator.
//
// Events:
//   'message' (msg: ParsedMessage)              a complete inbound transmission
//   'wire'    (d: { direction, text })          for the admin/audit log
//   'error'   (err: Error)
// =============================================================================
export interface ProtocolLink extends EventEmitter {
  readonly name: ProtocolName;
  /**
   * True when a download REPLACES the program the analyzer holds for that
   * sample id rather than adding to it (VITROS 250 over Kermit). The
   * orchestrator then sends the whole panel every time, not the delta.
   */
  readonly downloadReplacesProgram?: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Push a work-order download (host-query reply or broadcast) to the analyzer. */
  sendOrders(orders: OrderDownload[]): Promise<void>;
}

export interface WireEvent {
  direction: 'IN' | 'OUT';
  text: string;
  /** The packet-level exchange behind this frame, where the protocol has one
   *  (Kermit: "→S0 ←Y0(~* @-#N1\) →F1 ←Y1 …"). */
  trace?: string;
}

export type { ParsedMessage };
