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
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Push a work-order download (host-query reply or broadcast) to the analyzer. */
  sendOrders(orders: OrderDownload[]): Promise<void>;
}

export interface WireEvent {
  direction: 'IN' | 'OUT';
  text: string;
}

export type { ParsedMessage };
