import type { Transport } from '../transport/types.js';
import type { Logger } from '../logger.js';
import type { AnalyzerConfig } from '../config.js';
import type { ProtocolLink } from './types.js';
import { AstmLink } from './astm/link.js';
import { Advia2120Link } from './advia/link.js';
import { ClinitekAdvantusLink } from './clinitek/link.js';

// Factory for the pluggable protocol layer. Add HL7 here when needed:
//   case 'hl7': return new Hl7Link(transport, { ...mllp opts });
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
      throw new Error('HL7 codec not implemented yet — set protocol to "astm" or add Hl7Link.');
    default:
      throw new Error(`Unknown protocol: ${analyzer.protocol}`);
  }
}

export type { ProtocolLink } from './types.js';
