import type { Transport } from '../transport/types.js';
import type { Logger } from '../logger.js';
import type { AnalyzerConfig } from '../config.js';
import type { ProtocolLink } from './types.js';
import { AstmLink } from './astm/link.js';
import { Abl9Link } from './abl9/link.js';
import { Advia2120Link } from './advia/link.js';
import { ClinitekAdvantusLink } from './clinitek/link.js';
import { KermitLink } from './kermit/link.js';
import { Hl7Link } from './hl7/link.js';
import { Gh900Link } from './gh900/link.js';
import { H100Link } from './h100/link.js';
import { RollerLink } from './roller/link.js';
import { Abl800Link } from './abl800/link.js';

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
        sampleIdFrom: analyzer.astm.sampleIdFrom,
        valueFormat: analyzer.astm.valueFormat,
        logger: logger.child({ codec: 'astm' }),
      });
    case 'abl9':
      // Radiometer ABL9 — ASTM E1394 RECORDS inside a SOH…EOT stream, with no
      // E1381 framing at all. Its records are parsed by the same parser as
      // 'astm', so it reads sampleIdFrom and dialect from the astm block;
      // only the link layer differs. See src/codec/abl9/link.ts.
      return new Abl9Link(transport, {
        sampleIdFrom: analyzer.astm.sampleIdFrom,
        dialect: analyzer.astm.dialect,
        ack: analyzer.abl9.ack,
        maxBufferBytes: analyzer.abl9.maxBufferBytes,
        logger: logger.child({ codec: 'abl9' }),
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
        hostQuery: analyzer.hostQuery,
        queryStyle: analyzer.hl7.queryStyle ?? 'standard',
        mindrayNoOrderTestMode: analyzer.hl7.mindrayNoOrderTestMode,
        // Optional-chained: the schema always fills this in, but the test
        // harnesses build an analyzer config by hand.
        orderPush: analyzer.hl7.orderPush?.enabled ? analyzer.hl7.orderPush : undefined,
        logger: logger.child({ codec: 'hl7' }),
      });
    case 'gh900':
      // Lifotronic GH900 Plus HbA1c analyzer — proprietary fixed-width
      // STX…ETX block, results-only, the analyzer dials in. See src/codec/gh900/.
      return new Gh900Link(transport, {
        fileOnSamplingError: analyzer.gh900.fileOnSamplingError,
        logger: logger.child({ codec: 'gh900' }),
      });
    case 'h100':
      // Lifotronic H100 HbA1c analyzer — its own codec, results-only, the
      // analyzer dials in. See src/codec/h100/.
      return new H100Link(transport, {
        fileOnSamplingError: analyzer.h100.fileOnSamplingError,
        logger: logger.child({ codec: 'h100' }),
      });
    case 'abl800':
      // Radiometer ABL800 FLEX — HL7 ORU^R31 inside SOH…EOT, results-only,
      // the analyzer dials in. See src/codec/abl800/.
      return new Abl800Link(transport, {
        ackFraming: analyzer.abl800.ackFraming,
        logger: logger.child({ codec: 'abl800' }),
      });
    case 'alifax-roller':
      // Alifax ROLLER 20LC ESR — STX…ETX frames over RS-232 via an NPort,
      // results-only. See src/codec/roller/.
      return new RollerLink(transport, {
        verifyChecksum: analyzer.roller.verifyChecksum,
        ack: analyzer.roller.ack,
        answerQueries: analyzer.roller.answerQueries,
        fileLowHematocrit: analyzer.roller.fileLowHematocrit,
        shortIdPrefix: analyzer.roller.shortIdPrefix ?? null,
        logger: logger.child({ codec: 'alifax-roller' }),
      });
    case 'kermit':
      // The VITROS 250/350 chemistry systems do NOT speak ASTM on this link —
      // they exchange sample programs as Kermit file transfers, so this is a
      // separate protocol rather than an ASTM dialect.
      return new KermitLink(transport, {
        ackTimeoutMs: analyzer.kermit.ackTimeoutMs,
        maxRetries: analyzer.kermit.maxRetries,
        interPacketDelayMs: analyzer.kermit.interPacketDelayMs,
        interTransferDelayMs: analyzer.kermit.interTransferDelayMs,
        logger: logger.child({ codec: 'kermit' }),
      });
    default:
      throw new Error(`Unknown protocol: ${analyzer.protocol}`);
  }
}

export type { ProtocolLink } from './types.js';
