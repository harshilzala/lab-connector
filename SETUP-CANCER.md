# Cancer site — setup state

Prepared on this server (`10.12.100.172`, `C:\Users\Appsadmin\Desktop\lab-connector`).
**Nothing is started and nothing auto-starts.** Start it deliberately with
`Lab-Interface.bat` once the open items below are closed.

## What was installed

| | |
|---|---|
| Node.js | v24.20.0 LTS, portable, `C:\Users\Appsadmin\tools\node-v24.20.0-win-x64` (on the user PATH) |
| Dependencies | `npm install` — 65 packages, `serialport` included |
| PM2 | 7.0.4, global. Daemon is up; **no application registered** |
| Build | `dist/` compiled, typecheck clean |
| Env | `.env` seeded from `.env.example` — dashboard `admin` / `Zydus@2026`, change at first login |

Node had to go in portable: this account is not an administrator, `winget`
failed with access denied and `C:\` is not writable.

## Equipment, as configured

Taken from `E:\Devices_Cancer\*\*.exe.config` (a copy of
`D:\API Integration\Devices_Cancer` on the Cancer PC) and confirmed against the
wire logs beside them.

| Analyzer | id | eqCode | Protocol | Transport | MachineID |
|---|---|---|---|---|---|
| Radiometer ABL9 | `cancer-abl9` | `Cancer_ABL9` | ASTM E1394 | TCP server `0.0.0.0:6080` | 523 |
| Mindray BC-6000 | `cancer-bc6000` | `Cancer_BC6000` | HL7 v2.3.1 / MLLP | TCP server `0.0.0.0:6060` | 624 |
| VITROS ECi/ECiQ | `cancer-vitros-eciq` | `VitrosECIQ` | ASTM, `vitros-eciq` dialect | TCP client → NPort `:4001` | 2000 |
| VITROS 250 | `cancer-vitros-250` | `Vitros250` | Kermit | TCP client → NPort `:4001` | 2001 |

All four are **results-up only** at present — order download is held off, see
open item 1.

HMIS also lists the analyzer set as "BC 6000, VITROS ECI, VITROS 250, **ABL
800**". The folder, and the analyzer's own ASTM header (`ABL9^403237`), say
**ABL9**. Radiometer's ABL800 and ABL9 are different instruments with different
assay sets — worth confirming it is the same box.

How each setting was established:

- **ABL9 / BC-6000 listen, the analyzer dials in.** Both run the same
  `Lab Integration.exe`, which contains `TcpListener` and `AcceptTcpClient`, so
  the config's `IPAddress=10.11.100.101` was its own bind address, not the
  instrument's. Ports 6080 and 6060 are carried over unchanged.
- **ABL9 is results only.** `Communi_Data.Log` holds no `Q` records at all
  across a month — H/P/O/R/C/L only.
- **ECiQ timings** come from its own logs: `ASTM.log` shows a 15 s ACK timeout,
  `Flow.log` polls every 30 s, `DB_Query.log` looks back one day.
- **VITROS 250 is Kermit**, confirmed by the SOH/seq/type-Y framing in
  `Vitros250_String.txt`.
- **VITROS 250 packet pacing** is 1 s, copied from `VitrosDelayTime=1000` in
  the legacy config and visible in the capture as one packet per second. See
  "VITROS 250 order download" below.
- **VITROS 250 runs ZC tubes only.** `SamplePrefix=ZC` in the legacy config,
  and its SQL selected `sample_id LIKE 'ZC%'`. Every result sample in the
  legacy capture (84) and in this connector's own wire log (53) is `ZC`.

### VITROS 250 order download

Three findings from comparing the retired `Vitros250.exe` with this connector's
first day of live traffic (2026-09-06/07), all now fixed in `config.json`:

| | Legacy host | This connector, before | Now |
|---|---|---|---|
| Packet pacing | 1 s per packet | none, a whole file in ~0.8 s | `kermit.interPacketDelayMs: 1000` |
| Samples programmed | `ZC` only | all six prefixes HMIS lists, 1014 samples | `orderPoll.downloadPrefixes: ["ZC"]` |
| Single-name patient | `DEEPSHIKHA` | `.DEEPSHIKHA` | lone `.` dropped in `vitros250.ts` |

Sending flat out made the analyzer reject transfers outright — 160 of 1177 in
one day, `0005 INVALID PACKET USAGE` (125) and `0008 INVALID SEQUENCE USE`
(35), 151 of them within two seconds of the previous transfer ending. Each
rejection failed the download, tripped the order-download breaker (76 suspend
events that day) and re-sent the same order later: `LB2609070198` went out
seven times in 23 minutes. The legacy host, pacing every packet, drew no error
packet at all across its whole capture.

Pinned by `npm run vitros:pacing` and `npm run prefixes`.

**The ECiQ was checked for the same two problems and left alone.** Its ASTM
link has no comparable pacing fault, and while its results are also nearly all
`ZC` (24 of 25), one `LB` result is in the log — so it genuinely runs work for
the other sites and must keep receiving it. `downloadPrefixes` is deliberately
not set there.

## ABL9 — the interfaced parameter set

The lab supplied the ZCCEQ005 equipment-parameter table on 8 September. Four
services run on this analyzer and share one parameter set:

| Service | Parameters |
|---|---|
| Arterial Blood Gas(ABG)* | 18 — the full list |
| Venous Blood Gas (VBG)* | 17 — the same, without `T` |
| Bicarbonate(HCO3)-Serum | 1 — `HCO3-` |
| Ionized Calcium* | 1 — `Ca++` |

`config.json` now carries those 18 identifiers as `allowTestCodes` on
`cancer-abl9`. The table's Identifier column is spelled exactly as the ABL9
spells the analyte, so no aliases are needed. Because it is an allow-list it is
checked before `ignoreTestCodes` and decides everything: a code not named there
is dropped at delivery as `ignored` — never filed, never re-queued, and **not
counted as waiting**, so the sample goes complete as soon as its listed
parameters are in. The analyzer sends 38 channels per sample and 22 of them are
not interfaced.

Pinned by `test/abl9-allow-codes.test.ts` (`npm run abl9:allow`), which replays
all 414 envelopes of the legacy capture through the real join: 340 patient
samples, 16 codes filed, 8 ignored, **zero** left unmatched.

### Two requested parameters never arrive: `FIO2` and `T`

They are operator-entered on the ABL9, not measured, and this site does not
enter them. Across 414 samples in
`E:\Devices_Cancer\ABL9\Communi_Data.Log` there is not one `FIO2` or `T`
record, and all 14 channels derived from them — `pH(T)`, `pCO2(T)`, `pO2(A)`,
`AaDpO2`, `a/ApO2`, `RI`, `pO2(a)/FIO2` and the rest — arrive as the analyzer's
`.....` no-result placeholder and are dropped at intake. That is why a sample
carries 24 valued results, not 38.

The consequence is on the HMIS side and the connector cannot fix it: HMIS holds
a pending row for `T`, it never receives a value, and the ABG order stays open
however complete the sample looks here. Six ABG samples were observed in
exactly that state on 7 September, `T` the only row left
(`ZV2609070525`–`ZV2609070530`). Acknowledging that row without a value would
close the order by putting an empty parameter on a patient's report, which is
the same defect as the BC-6000 null values, so the connector does not do it.

**Decision for the lab:** either enter FIO2 and temperature on the analyzer
before transmitting, or remove those two parameters from the ABG/VBG mapping
for ZCCEQ005 in HMIS. Both codes stay in `allowTestCodes` either way, so they
file the moment they start arriving.

## BC-6000: HMIS withdraws its own CBC parameter rows

Found on **CH2609080028**, 8 September. HMIS showed the sample as "result
interfaced" with an empty report.

The analyzer was not at fault. It sent a complete CBC at 12:25:02 and the
connector parsed all 63 values. The problem is that
`GET /mirth/pending` stopped offering rows for 18 of the 22 interfaced
analytes. Results are filed against `labResultId` + `parameterId`, and the
pending row is the only place a `parameterId` is ever published — so an
analyte with no row cannot be filed at all.

The withdrawal is a live behaviour, not a one-off. On **CH2609080017** the same
morning the CBC panel was complete at 05:01:25 (38 rows, 22 under the
instrument mnemonic) and 29 seconds later it was 20 rows with only 4 mnemonics
left — with nothing filed in between. That sample was fine only because the
connector had already cached the full list. CH2609080028 was first seen *after*
its own collapse: all 29 polls that mentioned it returned the same 20 rows, so
WBC, RBC, HGB, HCT, PLT, the indices and the whole differential never had a row.
Four values filed, the sample flipped to interfaced, the report printed blank.

### What the connector now does

`fillMissingOrderRows: true` on `cancer-bc6000`. The connector remembers each
service's `parameterId`s and rebuilds a withdrawn row from that plus the
`labResultId` carried by a sibling row of the **same service on the same
sample**. Nothing is guessed: a `parameterId` is a property of the service and
is identical on every sample — 164 `(labServiceId, identifier)` pairs observed
across 9,338 polls on 8 September, zero conflicts — and the `labResultId` comes
from this sample's own rows. It is confined to `PARAMETER` services, so a
`Numeric` one-row-per-test service can never lend its `labResultId` to a
different analyte.

Replaying the real logs for CH2609080028 (`npm run replay:0028`) takes it from
**3 values filed, 15 waiting** to **18 filed, 0 waiting**, all on
`labResultId` 92910365. Guards pinned by `npm run params`.

Every rebuild is logged at **warn** with the identifiers and the `labResultId`,
so the collapses stay visible. This is a workaround for a gateway fault, not a
substitute for fixing it.

### Also fixed: the `****` placeholder was being filed

The BC-6000 withholds a value it will not stand behind — the LYM/MON
differential when a blast or abnormal-lymph flag fires — and prints `****`. On
CH2609080028 the connector posted `resultValue: "****"` for MON#, HMIS accepted
it, and that single accepted row is part of why the sample read as interfaced.
`****` is now treated as a placeholder like the VITROS `No Result` and the ABL9
`.....`: dropped at intake, never filed, and the order row is left open so a
rerun can fill it. It is the only non-numeric text the BC-6000 ever puts in an
NM field (590 occurrences across the wire logs).

### Still on the lab / HMIS side

16 CBC parameters are registered under a **bare number** in `eqIdntifier` — 42,
300, 460, 44, 101, 660, 81, 280, 76, 43, 50, 26, 290, 310, 25, 414 — instead of
the instrument mnemonic. The connector cannot rescue these and must not guess
which number is which analyte: a wrong guess files a value against the wrong
analyte on a patient's CBC. Fix the `eqIdntifier` column in the HMIS
equipment-parameter master for ZCCEQ004 if those parameters are to be
interfaced.

The withdrawal itself also needs an answer from the HMIS side: rows are
disappearing from `pending` for orders that nothing has filed against yet.

## Open items — must be closed before go-live

1. **The four `equipmentCode` values are locally defined, not HMIS-registered.**
   HMIS has a single registration — `EQ004`, "API_Integration_Cancer Hospital",
   `10.12.19.43` — which describes the middleware PC, not the instruments. The
   connector refuses to start with one code on two analyzers
   (`src/config.ts:365`), so the codes were taken from each device's own
   `MachineName` in `E:\Devices_Cancer`: `Cancer_ABL9`, `Cancer_BC6000`,
   `VitrosECIQ`, `Vitros250`.

   These are understood to be inert labels because the interface keys on
   SampleID — **an assumption, not a verified fact.** Confirm with one call:

   ```
   npm run ping -- <known-barcode> cancer-vitros-eciq
   ```

   If the gateway does honour `eqCode`, ask HMIS for four real `LabEquipment`
   rows and swap them in.

   **Order download is held off on all four** (`orderPoll.download: false`) as
   a consequence. The poll asks by `eqCode` with no `sampleId`; against a code
   HMIS does not know, the response is undefined — possibly empty, possibly the
   entire pending list, which would then be programmed onto a single
   instrument. Results-up is unaffected. Re-enable on the ECiQ and VITROS 250
   once the ping shows what actually comes back.

2. **The two VITROS NPort addresses are placeholders**
   (`TODO-NPORT-ECIQ`, `TODO-NPORT-V250`). Both are serial instruments
   (`ComVal=COM1` and `COM2`) and this server has no COM ports, so they have to
   come in over Moxa NPort in TCP server mode. The known-good direct-COM
   settings are parked in a commented block beside each one.

3. **Repoint the two TCP analyzers.** The ABL9 and BC-6000 are still pointed at
   `10.11.100.101`, the old Cancer PC. They must be pointed at this server,
   `10.12.100.172`, and the subnets must route to each other.

   The HMIS side needs nothing here — it is the same HMIS, reached outbound at
   `hmis.baseUrl`, and this server's address works for it. The `10.12.19.43` on
   the `EQ004` registration is not a constraint; the `ipAddress` reported in the
   acknowledge body is this host.

4. **`siteId` is deliberately omitted.** Nashik narrows its pending queries with
   `siteId=9246332`; the Cancer site's id is unknown and a wrong one returns no
   orders at all, so no narrowing is the safe default. Add it once confirmed.

5. **BC-6000 order download is off** (`hostQuery: false`). The analyzer answers
   a query with `ORR^O02` — see the legacy `SendTestOrder.log` — but this
   connector's HL7 link replies `ORM^O01` (`src/codec/hl7/link.ts:279`).
   Results-up is unaffected; sending it a worklist needs a code change, not a
   config flip.

## Running without "Run as administrator"

The `Lab-Interface*` scripts are meant to be double-clicked by whichever
operator is at the machine, with no elevation. Two things stopped that, and the
scripts now deal with both.

**1. The PM2 home was owned by a service.** `PM2_HOME` is set machine-wide to
`C:\ProgramData\pm2\home`, which belongs to the LocalSystem **PM2** service.
Its files grant `BUILTIN\Users` read-only, so an unelevated `pm2` could not
write `pm2.pid` and died with

```
PM2 error: EPERM: operation not permitted, open 'C:\ProgramData\pm2\home\pm2.pid'
```

Every call then left a half-started daemon behind — 177 stray `node.exe`
daemons had accumulated on 7 September before this was found. The scripts now
set `PM2_HOME` to `.pm2` beside the connector, and `Lab-Interface.bat` grants
`BUILTIN\Users` Modify on the folder tree once (marker: `.pm2\.shared-access`).
Both are done by the folder's owner and need no elevation. The grant also fixes
the quieter half of the problem: a second operator could not compile into
`dist\`, write `logs\` and `spool\`, or clear `.lab-maintenance`, because the
tree gave Users read-and-execute only — and an administrator's *unelevated*
token carries that group membership as deny-only, so even `Administrator` hit
it.

**2. The LocalSystem PM2 service still forces elevation, and only the site can
remove it.** On Windows, PM2's daemon sockets are the fixed pipes
`\\.\pipe\rpc.sock` and `\\.\pipe\pub.sock` — they are **not** derived from
`PM2_HOME`. A pipe created by LocalSystem is reachable only by SYSTEM and by
elevated administrators, so while that service runs, an ordinary session can
neither talk to its daemon nor start one of its own, whatever `PM2_HOME` says.
`Lab-Interface.bat` detects the service and prints what to do:

```powershell
sc.exe stop pm2.exe
sc.exe delete pm2.exe
```

**This is a genuine trade-off, not a cleanup.** That service is what starts the
connector at boot with nobody logged on. Remove it and the connector starts
from the per-user logon entry and the 5-minute watchdog instead, i.e. when an
operator logs in. Keep the service if unattended boot matters more than
unelevated operation — but then the scripts must be run as administrator.

The watchdog task is now registered per account
(`Lab-Interface Watchdog - <user>`), because a task runs only in its owner's
session and rewriting somebody else's task needs elevation. To stop two
supervisors ever starting two connectors, `Lab-Interface-startup.cmd` first
checks whether anything is already listening on the dashboard port and exits if
so. Keep that port in step with `admin.port` in `config.json`.

## Verification run here

`npm run build`, `npm run typecheck`, all 15 `test/*.test.ts`, plus
`simulator`, `orders`, `dialects`, `kermit` and `kermit:corpus` — all pass.

`kermit:corpus` now replays the **Cancer** VITROS 250 capture (it previously
skipped, looking only at the Nashik path): 47 orders rebuild byte-for-byte and
416 results across 86 samples parse with every checksum good. One logged order
line is excluded as unverifiable — the legacy logger wrote four 8-bit payload
bytes as UTF-8 sequences, so that line's checksum cannot be reproduced from the
log. That is damage on the way to disk, not a codec fault.

## Changes made to the project

- `config.json` — rewritten for the four Cancer analyzers. The previous Nashik
  config is preserved as `test/fixtures/reference-config.json`.
- `test/{ack-after-file,h360-hmis-join,void-result}.test.ts` — these looked up
  `erba-h360` / `vitros-eciq` in the deployed `config.json` and so died at a
  site without those analyzers. They now read the reference fixture, which is
  what they were really asserting against.
- `test/config-jsonc.test.ts` — the parked-COM-port allow-list was `COM2`/`COM3`
  (Nashik). Cancer uses `COM1`/`COM2`, so `COM1` was added.
- `test/kermit-corpus.ts` — looks for the capture in the Cancer folder as well
  as the Nashik one, accepts the Cancer log's timestamp format, and reports
  logger-damaged lines separately from checksum failures.
- `src/codec/kermit/link.ts` — Kermit packet pacing
  (`interPacketDelayMs` / `interTransferDelayMs`), so the link sends at the
  rate the analyzer accepted from the legacy host. See "VITROS 250 order
  download" above. Pinned by `test/vitros250-pacing.test.ts`.
- `src/session/orchestrator.ts` — `orderPoll.downloadPrefixes`, so an analyzer
  is only programmed with the barcodes it actually runs. Rows outside the list
  are still cached for result-time joins. Pinned by
  `test/download-prefixes.test.ts`.
- `src/codec/kermit/vitros250.ts` — a lone `.` from HMIS's `LName` no longer
  reaches the analyzer's patient-name field.
- `config.json` — `allowTestCodes` on `cancer-abl9`: the 18 parameters HMIS
  registers for the ABG, VBG, Bicarbonate and Ionized Calcium services. Pinned
  by the new `test/abl9-allow-codes.test.ts` (`npm run abl9:allow`). See
  "ABL9 — the interfaced parameter set" above.
- `test/bc6000-allow-codes.test.ts` — its cross-analyzer check asserted that
  only the BC-6000 was allow-listed; the ABL9 is now scoped too.
- `Lab-Interface.bat`, `-stop.bat`, `-force-stop.ps1`, `-startup.cmd`,
  `-remove-startup.bat` — run unelevated for any account: project-local
  `PM2_HOME`, a one-time shared-access grant, a per-account watchdog task, a
  port check that stops two supervisors double-starting the connector, and a
  warning when the LocalSystem PM2 service is present. See "Running without
  'Run as administrator'" above.

Still on the retired stack: the Cancer devices under `E:\Devices_Cancer` were
not touched, and neither were the Old Interface controls in `old-interface/`.
