import type { Transport } from '../transport/types.js';
import type { Logger } from '../logger.js';
import type { AnalyzerConfig } from '../config.js';
import type { ProtocolLink } from './types.js';
import { AstmLink } from './astm/link.js';
import { Advia2120Link } from './advia/link.js';
import { ClinitekAdvantusLink } from './clinitek/link.js';
import { KermitLink } from './kermit/link.js';
import { Hl7Link } from './hl7/link.js';

// Factory for the pluggable protocol layer.
export function createProtocolLink(analyzer: AnalyzerConfig, transport: Transport, logger: Logger): ProtocolLink {
  switch (analyzer.protocol) {
    case 'astm':
      return new AstmLink(transport, {
        senderId: analyzer.astm.senderId,
        receiverId: analyzer.astm.receiverId,
        ackTimeoutMs: analyzer.astm.ackTimeoutMs,
        frameMaxData: analyzer.astm.frameMaxData,
        dialect: analyzer.astm.dialect,
        logger: logger.child({ codec: 'astm' }),
      });
    case 'advia2120i':
      return new Advia2120Link(transport, {
        logger: logger.child({ codec: 'advia2120i' }),
        machineId: analyzer.machineId,
      });
    case 'clinitek-advantus':
      return new ClinitekAdvantusLink(transport, { logger: logger.child({ codec: 'clinitek-advantus' }) });
    case 'hl7':
      // HL7 v2 over MLLP — the Erba H360 hematology analyzer. See src/codec/hl7/.
      return new Hl7Link(transport, {
        sendingApp: analyzer.hl7.sendingApp,
        sendingFacility: analyzer.hl7.sendingFacility,
        charset: analyzer.hl7.charset,
        ack: analyzer.hl7.ack,
        valueTypes: analyzer.hl7.valueTypes,
        encoding: analyzer.hl7.encoding,
        idleFlushMs: analyzer.hl7.idleFlushMs,
        logger: logger.child({ codec: 'hl7' }),
      });
    case 'kermit':
      // The VITROS 250/350 chemistry systems do NOT speak ASTM on this link —
      // they exchange sample programs as Kermit file transfers, so this is a
      // separate protocol rather than an ASTM dialect.
      return new KermitLink(transport, {
        ackTimeoutMs: analyzer.kermit.ackTimeoutMs,
        maxRetries: analyzer.kermit.maxRetries,
        logger: logger.child({ codec: 'kermit' }),
      });
    default:
      throw new Error(`Unknown protocol: ${analyzer.protocol}`);
  }
}

export type { ProtocolLink } from './types.js';
