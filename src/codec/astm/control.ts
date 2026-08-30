// ASTM E1381 low-level control characters (a.k.a. LIS1-A).
export const ENQ = 0x05; // enquiry  — request to establish a transfer
export const ACK = 0x06; // acknowledge — frame/enquiry accepted
export const NAK = 0x15; // negative acknowledge — resend the frame
export const STX = 0x02; // start of a frame
export const ETX = 0x03; // end of the LAST frame of a record
export const ETB = 0x17; // end of an INTERMEDIATE frame (record continues)
export const EOT = 0x04; // end of transmission — release the line
export const CR = 0x0d;
export const LF = 0x0a;

export const CONTROL_NAMES: Record<number, string> = {
  [ENQ]: 'ENQ',
  [ACK]: 'ACK',
  [NAK]: 'NAK',
  [STX]: 'STX',
  [ETX]: 'ETX',
  [ETB]: 'ETB',
  [EOT]: 'EOT',
  [CR]: 'CR',
  [LF]: 'LF',
};

export function ctrlName(byte: number): string {
  return CONTROL_NAMES[byte] ?? `0x${byte.toString(16).padStart(2, '0')}`;
}
