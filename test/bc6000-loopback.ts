/**
 * Proves the BC-6000 MLLP listener accepts and parses a message.
 *
 * Sends one ORU^R01 shaped like the real BC-6000 traffic in
 * E:\Devices_Cancer\Mindray_BC_6000\logggg.log, but under a QC barcode so the
 * connector's qc filter drops it before any HMIS upload. Nothing is filed.
 */
import { connect } from 'node:net';

const HOST = process.argv[2] ?? '10.12.100.172';
const PORT = Number(process.argv[3] ?? 6060);
const BARCODE = 'QCLINKTEST';

const VT = '\x0b', FS = '\x1c', CR = '\r';
const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);

const msg = [
  `MSH|^~\&|LabXpert|Mindray|||${stamp}||ORU^R01|${stamp}|P|2.3.1||||||UNICODE`,
  `PID|1||${BARCODE}||CONNECTIVITY^TEST||19700101|F`,
  `OBR|1||${BARCODE}|00001^Automated Count^99MRC|||${stamp}`,
  `OBX|1|NM|6690-2^WBC^LN||7.10|10*9/L|4.00-10.00|N|||F`,
  `OBX|2|NM|789-8^RBC^LN||4.55|10*12/L|3.50-5.50|N|||F`,
].join(CR) + CR;

const sock = connect({ host: HOST, port: PORT }, () => {
  console.log(`connected to ${HOST}:${PORT} from ${sock.localAddress}:${sock.localPort}`);
  sock.write(VT + msg + FS + CR);
  console.log(`sent ORU^R01, barcode ${BARCODE}, 2 OBX rows`);
});

sock.setTimeout(12000);
sock.on('data', (d) => {
  const text = d.toString('utf8').replace(/[\x0b\x1c]/g, '').trim();
  console.log('\n--- reply from connector ---');
  console.log(text.replace(/\r/g, '\n'));
  console.log(/MSA\|A[AC]/.test(text) ? '\nACCEPTED (MSA|AA/AC)' : '\nreply received, not a positive ACK');
  sock.end();
});
sock.on('timeout', () => { console.log('\nNO REPLY within 12s'); sock.destroy(); });
sock.on('error', (e) => console.log('socket error:', e.message));
sock.on('close', () => console.log('closed'));
