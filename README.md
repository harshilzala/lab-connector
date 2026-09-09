# HMIS Lab Connector

Bidirectional LIS middleware between **Siemens Atellica** (and other ASTM/HL7)
analyzers and the HMIS laboratory module. Runs on a local PC on the lab LAN,
next to the analyzer.

```
  Atellica CI  ⇄  [ ASTM E1381/E1394 over TCP or Serial ]  ⇄  LAB-CONNECTOR  ⇄  [ HTTPS ]  ⇄  HMIS
   (analyzer)                                                  (this app)                       /mirth/*
                                                          durable spool + admin UI
```

- **Orders down (host-query):** analyzer reads the tube barcode → asks the
  connector → connector asks HMIS `GET /mirth/pending?sampleId=&eqCode=` →
  downloads the ordered tests back to the analyzer → `POST /mirth/acknowledge`
  so the rows are not offered again.
- **Results up:** analyzer sends results → connector maps + queues them durably →
  `POST` to the results endpoint → results land against the sample as
  `RESULT_INTERFACE` for tech verification.

## Why a middleware PC?

The low-level ASTM line protocol (ENQ/ACK framing, checksums, retransmit) is
fiddly and patient-safety-critical, and analyzers live on an isolated lab VLAN.
This connector isolates all of that on the lab floor and speaks clean, signed
REST to the HMIS server. If the network or server is down, results are held in a
**durable on-disk spool** and delivered when connectivity returns — nothing is
lost.

## Architecture

| Layer | Files | Responsibility |
|---|---|---|
| Transport (pluggable) | `src/transport/` | TCP (server/client) or Serial byte pipe |
| Codec (pluggable) | `src/codec/astm/` | E1381 framing + E1394 records ⇄ structured messages |
| Session | `src/session/orchestrator.ts` | host-query + result flows per analyzer |
| Mapping | `src/mapping/mapper.ts` | QC detection, group-by-sample, idempotency key |
| HMIS client | `src/hmis/client.ts` | signed REST calls to the HMIS |
| Store-and-forward | `src/queue/spool.ts` | durable, retrying delivery queue |
| Admin | `src/admin/` | local dashboard (connection, wire log, queue) |
| Commissioning | `src/probe/` | Connector Tool — discover, probe and fingerprint an unknown device |

Swapping ASTM ↔ HL7 is a new codec in `src/codec/` + a case in
`src/codec/index.ts` — nothing else changes.

### Instrument dialects

Inbound parsing is vendor-neutral — the Q/O/R record positions read every
analyzer we have logs for. The **order download** is not: vendors disagree on
how to express "run these assays on this tube", and an analyzer quietly ignores
or rejects an order it cannot parse. Pick one per analyzer with
`astm.dialect` (default `atellica`):

| | `atellica` | `maglumi` |
|---|---|---|
| O records | one, all assays repeat-delimited | **one per assay** |
| Universal Test ID | `^^^CODE^^^1` (rank/dilution required) | `^^^CODE` |
| O fields 12 + 16 | report type `O` + specimen descriptor | **omitted** |
| P record (no demographics) | `P\|1\|\|\|\|\|\|\|` | `P\|1` |
| H version / password | `LIS2-A2` / *(empty)* | `E1394-97` / `PSWD` |
| H timestamp | `YYYYMMDDHHMMSS` | **`YYYYMMDD`** (date only) |

```
atellica   O|1|1234567||^^^CA125^^^1\^^^CA153^^^1|R|||||||O|||Serum
maglumi    O|1|1234567||^^^CA125|R
           O|2|1234567||^^^CA153|R
```

Add a machine by adding an entry to `ORDER_FORMATS` in
[`src/codec/astm/records.ts`](src/codec/astm/records.ts) — the config enum
derives from that table, so nothing else changes.

`npm run dialects` replays the captured Snibe Maglumi wire logs through the
codec and diffs the generated download against the vendor spec.

## Prerequisites

- Node.js ≥ 20 on the lab PC.
- Network route from the PC to (a) the analyzer and (b) the HMIS gateway.
- In HMIS: a `LabEquipment` row for this analyzer with connectivity configured.
  Its equipment code goes in this connector's config as `equipmentCode` and is
  sent as the `eqCode` query parameter — there is no id/secret pair any more.

## Install & configure

```bash
npm install
cp config.example.json config.json     # then edit
cp .env.example .env                    # optional — keep secrets out of config.json
```

Edit `config.json`:

- `hmis.baseUrl` — your HMIS server (better via env `HMIS_BASE_URL`).
- `hmis.pendingPath` / `acknowledgePath` / `resultsPath` — default to
  `/mirth/pending`, `/mirth/acknowledge`, `/mirth/results`.
- One entry per analyzer under `analyzers[]`:
  - `equipmentCode` — **required**; sent as `eqCode` to identify the machine.
  - `extraEquipmentCodes` — other `eqCode`s HMIS raises this *same* machine's
    orders under (a re-registered analyzer keeps its old code on the tests
    nobody re-mapped). Polled and merged with `equipmentCode`; a code may
    belong to one analyzer only.
  - `equipmentId` — optional numeric HMIS id, used as a fallback in the
    acknowledge body and the results upload when a pending row omits it.
  - `siteId` / `showCulture` — optional pass-through query parameters.
  - `orderPoll` — proactive order download, the real-time half of the
    interface. `{ enabled, intervalMs (default 60000), lookbackDays (default 1),
    download (default true) }`. Every tick asks the pending endpoint for each
    of the machine's codes × each day in the window, folds the rows into the
    **order store** (`spool/<id>/orders/`, one JSON per barcode), and pushes to
    the analyzer only the tests it has not been given. Rows are *not*
    acknowledged at download — that still happens after the result is filed —
    so the store is what stops a sample being programmed twice. `download:
    false` keeps the row cache for a results-only link (HL7 H360).
    The store also answers result-time lookups, which is what makes a result
    filable after its row was acknowledged (rerun, correction, restart) — HMIS
    never returns an acknowledged row again.
    `downloadPrefixes` restricts which barcodes are *programmed*: rows for any
    other prefix are still cached (so a result can be joined) but never sent.
    Use it where the gateway lists more work under an equipment code than the
    instrument actually runs — the VITROS 250 is offered six barcode prefixes
    and returns results only for `ZC`. Empty means download everything.
  - `sendDate` — send today's date (`dd-MM-yyyy`) as the `date` parameter.
    Default **false**, so an order raised yesterday for a tube run today is
    still found.
  - `transport` — `tcp` (`mode: server` means the analyzer dials in) or `serial`.
  - `sendDemographics` — default **false**; send only barcode + tests to the
    analyzer (recommended for privacy). Turn on only if the analyzer needs it.
  - `qc.sampleIdPrefixes` — barcodes starting with these are treated as QC, not
    patient results.

## Run

```bash
npm run dev        # watch mode (development)
npm run build      # compile to dist/
npm start          # run compiled

npm run simulator  # offline self-test of the ASTM codec (no hardware/HMIS)
npm run orders     # order-store / poll bookkeeping self-test

# One-off, when taking over from the retired middleware: seed the order store
# with the rows its Orders service pulled (and acknowledged) so results for
# those tubes can still be filed. Reads E:\API_Integration\Services\Orders.
npm run import:old-orders -- --days 7
```

Open the local dashboard at **http://127.0.0.1:7070** (`admin.host` / `admin.port`)
to watch connection state, the live wire log, and the upload queue (with manual
retry for parked items).

## Dashboard access

There is no sign-in. The console is reachable by anyone who can open
`admin.host:admin.port`, so the default **127.0.0.1** bind is the only thing
keeping the wire log — which carries patient barcodes and results — off the
network. If you move `admin.host` off loopback, put an authenticating reverse
proxy in front of it.

### Run as a Windows service

Use [NSSM](https://nssm.cc/) (simplest) or `node-windows`:

```powershell
nssm install HmisLabConnector "C:\Program Files\nodejs\node.exe" "C:\lab-connector\dist\index.js"
nssm set HmisLabConnector AppDirectory "C:\lab-connector"
nssm set HmisLabConnector AppStdout "C:\lab-connector\logs\out.log"
nssm set HmisLabConnector AppStderr "C:\lab-connector\logs\err.log"
nssm start HmisLabConnector
```

## Connector Tool — commissioning a machine we have never seen

The dashboard's **Connector Tool** (`/connector`) is the universal monitor: it
connects to a device over any transport with **no protocol assumed**, records
what comes back, and tells you what the device is speaking. It exists so adding
an analyzer stops being an archaeology project.

Nothing in it touches the interface. A probe never files a result, never writes
to the spool and never calls HMIS — it is a listening instrument that happens to
live in the same process.

It works in the order commissioning actually goes:

**1 · Discover — where is the machine?**
Sweep a host, a range (`10.12.19.1-254`) or a CIDR (`10.12.19.0/24`) across the
built-in analyzer port list — the ports our own machines use, plus the defaults
of the terminal servers (Moxa/Lantronix/Digi), MLLP, DICOM, Modbus and raw-print
conventions. Each open port reports its latency, whatever the device volunteered
on connect, and a guess at the service. For serial, it enumerates the COM ports
with their USB vendor/product ids and sweeps the common baud rates, ranking them
by how much sane data arrived. Both scans are read-only.

**2 · Probe — open the link with no codec bound.**
TCP in either direction (listen for a device that dials in, or dial one) or
serial with full line settings. Every byte is timestamped and rendered the way
the wire log renders it (`<ENQ>`, `<STX>`, `<0D>`), and you can push arbitrary
bytes back — typed as text with those same mnemonics and `\r` / `\xNN` escapes,
or as hex.

**Auto-answer handshakes** is on by default and matters more than it looks. An
ASTM analyzer sends `ENQ`, waits for an `ACK` that never comes, and abandons the
transmission — so without it your capture is one byte long and says nothing.
With it on, the probe plays a minimal, protocol-neutral receiver: it ACKs an ENQ
and each frame, and returns an `MSA|AA` to an HL7 MLLP block. It never parses,
files or forwards what it receives.

**3 · Identify — what is it speaking?**
The capture is scored against every detector and the candidates are ranked with
their evidence, because lab protocols overlap: E1394 records ride inside E1381
framing on most analyzers, bare inside `SOH…EOT` on the ABL9, and inside a
Kermit transfer on a VITROS 250. A single "is it X" test mislabels as often as it
labels, so you see the ranking and the reasoning rather than a verdict.

Thirty detectors, grouped the way the estate is: **laboratory analyzers**,
**patient monitors / ventilators / point of care**, **imaging**, **hospital
interoperability formats**, **instrument and building buses**, **transport and
link layers**, and generic shapes.

| Family | Detects | Implemented here |
|---|---|---|
| **Lab** ASTM E1381 / LIS1-A | framing, verified modulo-256 checksums, ETB continuation, record types, delimiter and version from the H record | `astm` |
| **Lab** ASTM E1394 unframed | `SOH…EOT` record stream with no framing at all | `abl9` |
| **Lab** HL7 v2 | MLLP `VT…FS CR` blocks *or raw*, MSH, message type, segment inventory, version | `hl7` |
| **Lab** Kermit | well-formed packets, Send-Init/EOF | `kermit` |
| **Lab** ADVIA 2120i | STX blocks with no E1394 header, hematology mnemonics | `advia2120i` |
| **Lab** CLINITEK Advantus | urinalysis pad mnemonics in a print stream | `clinitek-advantus` |
| **Lab** HPRIM | explicit HPRIM marker (ASTM-like records, different field map) | — |
| **Monitor** IEEE 11073-20601 | APDU tag + length, data-proto-id 20601 | — |
| **Monitor** POCT1-A / A2 | CLSI topic elements (`HELLO`, `OBS.R01`, `DEV.`, `SVC.`) | — |
| **Monitor** vendor ASCII frame | control-opened frames with a **verified** modulo-256 hex checksum — the Dräger MEDIBUS / Nihon Kohden / Spacelabs shape | — |
| **Imaging** DICOM | `DICM` magic, all seven upper-layer PDU types, UID root `1.2.840.10008` | — |
| **Interop** HL7 FHIR | `resourceType` (JSON) or the FHIR namespace (XML) | — |
| **Interop** HL7 v3 / CDA | `<ClinicalDocument>`, `urn:hl7-org:v3` | — |
| **Bus** Modbus/TCP | MBAP header, length and function code agreement | — |
| **Bus** Modbus RTU | **verified CRC-16/MODBUS** on consecutive frames | — |
| **Bus** BACnet/IP | BVLC header `0x81`, function, length agreement | — |
| **Bus** OPC UA binary | `HELF`/`ACKF`/`MSGF`/`OPNF`… + 32-bit LE length | — |
| **Bus** MQTT | CONNECT packet, `MQTT`/`MQIsdp` protocol name, varint length | — |
| **Bus** SNMP | ASN.1 BER SEQUENCE + version (v1/v2c/v3) | — |
| **Link** TLS / SSL | record layer, ClientHello/ServerHello | — |
| **Link** Telnet | IAC WILL/WONT/DO/DONT negotiation | — |
| **Link** XMODEM / YMODEM | ones-complement block numbers, 128 vs 1024-byte blocks | — |
| **Link** service banners | FTP, SSH, SMTP, POP3, IMAP greetings | — |
| **Link** HTTP, syslog | request/status line; RFC 3164/5424 priority | — |
| **Print** ZPL / ESC-P / PCL | `^XA…^XZ`, `ESC @`, `ESC E` | — |
| **Generic** JSON, XML, delimited/fixed-width, unknown binary | shape only — suppressed as soon as anything specific matches | — |

### What a detector is allowed to claim

Structure only: magic numbers, framing, length agreement and above all
**verified checksums**. Vocabulary is a lead, never an identification — the tool
says "these look like hematology mnemonics, confirm against the spec", because
every hematology analyzer ever built uses `WBC`. Modbus RTU is claimed *only*
when a CRC-16 actually verifies, and corrupting one byte withdraws the claim.
Where a family is recognisable but the vendor is not — the ventilator frame
shape is shared by Dräger, Nihon Kohden and Spacelabs — the tool names the
candidates to check rather than picking one. A confident wrong answer sends a
biomed engineer down a blind alley for a day; a ranked list with its reasoning
does not.

Three findings pay for the whole tool on their own, because each one explains a
port that otherwise just looks dead:

- **TLS** — the port is encrypted, so no amount of raw probing will ever show
  plaintext. Stop and go and find the device's security settings.
- **Telnet negotiation** — the terminal server is injecting option bytes into
  the analyzer's stream. Switch that channel to RAW mode or every frame is
  corrupt.
- **7-bit data with a parity bit** — reported as a byte-level observation when
  masking off the high bit turns garbage into clean text. Reopen the port as
  7-E-1. This one costs an afternoon if you don't spot it.

When the winner is a protocol this connector already speaks, the tool emits a
ready-to-paste `analyzers[]` block carrying the transport the probe actually
used. Two things it deliberately does **not** guess:

- **the order-download dialect** — a capture of the analyzer's *results* cannot
  reveal how that vendor wants an *order* expressed. It stays at the default and
  must come from the host-interface spec (see the dialect table above).
- **`equipmentCode` / `id`** — these come from HMIS, not from the wire.

When the winner is a protocol we do not implement, no config block is offered —
the evidence is what a new codec in `src/codec/` would have to handle.

You can also paste a capture taken elsewhere (a wire-log line, a hex dump, a
vendor trace) and analyse that instead of running a probe. `npm run
connector-tool` exercises the whole tool against a fake analyzer, with no
hardware and no HMIS.

## Result filing: queue or staged

Each analyzer chooses how its results reach HMIS with `filing.mode`:

- **`queue`** (default) — one spool item per message under
  `spool/<analyzer>/pending/`, delivered in order. An item that cannot be
  filed (its HMIS order does not exist yet) is retried up to 50 times and then
  parked in `failed/`, and while it is being retried nothing behind it is
  delivered.
- **`staged`** — the behaviour of the retired Lab Integration.exe, rebuilt on
  files instead of its MySQL staging table. Every value is written into a
  per-sample file under `spool/<analyzer>/results/<barcode>.json` the moment
  it arrives, and a filing pass (every `passIntervalMs`, after every order
  poll, and on every inbound result) joins each sample to the order rows known
  right now, posts what matches, acknowledges those rows and leaves the rest
  waiting. Samples are independent: a tube run before its order was raised
  simply files when the order appears, and never holds up another sample.
  Nothing is parked; a value waits until it files or ages out after
  `retention.days`. A re-sent message changes nothing, a rerun replaces the
  value and re-files it, and a sample the operator typed with the wrong id can
  be **re-keyed** to the real barcode from the dashboard ("Results" tab →
  Re-key), which is what the old system's sample-ID correction did. A waiting
  sample is looked up at HMIS directly once when first seen and then no more
  often than `recheckMs`; the order poll covers the normal case.

The Cancer site runs the ABL9 and the BC-6000 staged and both VITROS queued.
Switching an analyzer to staged migrates whatever its queue still holds into
the store on the next start, so nothing already received is lost.

## Log & spool retention

Four things grow on disk. Each is bounded, but by a different mechanism.

| What | Where | Bounded by |
|---|---|---|
| HMIS transaction log | `logs/hmis-YYYY-MM-DD.log` | one file per day, deleted after `retention.logDays` (30) |
| Analyzer wire logs | `logs/wire-<analyzer>-YYYY-MM-DD.log` | one file per analyzer per day, deleted after `retention.logDays` (30) |
| PM2 stdout/stderr | `logs/lab-interface.{out,err}.log` | `pm2-logrotate` — see below |
| Unfiled results | `spool/<analyzer>/{pending,failed}` | deleted after `retention.days` (7) |

### Daily log files

The HMIS log and every wire log are written by `src/maintenance/daily-log.ts`:
the configured name (`hmis.auditLog`, default `logs/hmis.log`) is only a base,
and each entry goes to the file for the **local calendar day** beside it.
Nothing is ever dropped by size — a day that grows past `hmis.auditMaxBytes`
(10 MB) continues in a numbered part (`hmis-2026-09-07.1.log`) and the day
carries on in a fresh file. Files are only ever removed by age.

- `logs/hmis-2026-09-07.log` — every pending poll, acknowledge and result
  upload that day, each line carrying the URL, the **full request payload**,
  the HTTP status and the gateway's **full response**, plus an `outcome`
  verdict.
- `logs/wire-cancer-abl9-2026-09-07.log` — every frame the ABL9 sent or was
  sent that day, verbatim (control characters rendered as `<SOH>`, `<VT>` and
  so on, so the line stays readable).
  One such family per analyzer id.

To trace a sample across the whole window, grep the family:

```
findstr ZC2609070002 logs\hmis-*.log
findstr ZC2609070002 logs\wire-cancer-abl9-*.log
```

### The sweeper

`src/maintenance/retention.ts` runs at startup and every `sweepIntervalHours`.
It deletes files in `logDir` whose last write is older than `logDays`, and
spool items older than `days`:

```json
"retention": {
  "days": 7,
  "logDays": 30,
  "sweepIntervalHours": 6,
  "logDir": "./logs",
  "includeSpoolPending": true
}
```

A day file stops changing at midnight, so it expires exactly `logDays` later.
The two windows are separate on purpose: the evidence trail is worth keeping
for a month, an undeliverable result is not. Set `days: 0` to switch the whole
sweep off.

Spool age is read from the envelope's `createdAt`, not the file's mtime — a
retry rewrites the file to bump `attempts`, and an item failing every 15s would
otherwise look permanently fresh and never expire.

**A spool item is a patient result that never reached HMIS.** Items are deleted
the moment they file successfully, so anything still in `pending/` or `failed/`
is unfiled work, and removing it discards it for good. Every such deletion is
logged at warn with its barcode *before* the file goes:

```
warn discarding an unfiled result past the retention window
  {"analyzer":"meglumi","bucket":"failed","id":"OLD001-aaa",
   "barcode":"OLD001","results":1,"attempts":50,"days":7}
```

Set `includeSpoolPending: false` to keep undelivered work indefinitely and clear
only `failed/`.

### PM2 logs

PM2 appends to `lab-interface.out.log` / `.err.log` forever and never rotates
them. The sweeper cannot help: their mtime is always current, so they are never
"old". Install the rotation module once per machine:

```
npm run pm2:logrotate
```

That sets daily rotation, `retain 30` and gzip — a 30-day window matching
`retention.logDays`, with a 10 MB size cap so a log storm rotates early.
Rotated files stop being written, so the sweeper then expires them as a
backstop.

The script (`scripts/setup-logrotate.mjs`) is idempotent: it reads the current
module config and writes only the keys that differ, so a re-run on a configured
machine prints "nothing to do" and restarts nothing. Do NOT chain `pm2 set`
calls by hand — each one restarts the module and re-prints its whole config,
which looks alarmingly like a stuck loop.

Verify with `pm2 conf pm2-logrotate`.

## ⚠️ Confirm against the vendor spec before go-live

The record field positions follow the **ASTM standard**, but the exact component
that carries the assay code and any vendor-specific fields **must** be verified
against that unit's host-interface specification — for the Atellica the *"Host
Interface / LIS Interface Specification"*, for the Maglumi *Chapter 16, Host
Result Management*. Search the codebase for `VERIFY-SPEC` — each marks a
position to confirm:

- Universal Test ID component that holds the assay code (`records.ts`).
- Patient ID field (lab-assigned vs practice-assigned).
- Result "date completed" field position.
- Whether the unit does **host query** at all, or only batch download.

## Commissioning checklist (patient safety)

1. Run `npm run simulator` — codec sanity.
2. Point at a **staging** HMIS; bench-test with the analyzer using **QC material
   and known samples**; confirm values match on the HMIS result-entry screen.
3. Verify QC/control samples route to the QC module, **not** patient results.
4. Confirm interfaced results require **tech verification/certification** before
   clinicians see them (they land as `RESULT_INTERFACE`).
5. Confirm an **unmatched barcode** or **unmapped test code** is surfaced (admin
   dashboard + server log), never silently dropped.
6. **Parallel run** (interface + manual entry) until 100% agreement, then cut over.

## Server-side pairing (in the HMIS repo)

This connector talks to three endpoints, **unauthenticated** — no equipment id,
no shared secret, no HMAC signature:

- `GET /mirth/pending` — load orders. All parameters are optional; the connector
  sends `sampleId` (uppercased barcode) and `eqCode` (the analyzer's
  `equipmentCode`), plus `siteId`, `showCulture` and `date` (`dd-MM-yyyy`) when
  configured. The response is expected to be **one row per pending test**, so
  several rows share a `sampleID`.
- `POST /mirth/acknowledge` — an array of the rows just handed to the analyzer,
  in the shape `{ sampleID, equipmentId, identifier, ipAddress, isTransmitted,
  labResultId, labServiceId, portNo, parameterId }`. Sent only **after** the
  download succeeds, so a failed download stays pending.
- `POST /mirth/results` — analyzer results, idempotent on `messageId`.

The pending row's `identifier` is read as the instrument assay code. Patient and
specimen column naming varies by deployment, so `src/hmis/pending.ts` resolves
those through an alias list (`patientName`/`firstName`, `dob`/`birthDate`,
`specimenType`/`sampleType`, …) and leaves anything it cannot match null rather
than guessing. If a real response uses different names, add them to the `*_KEYS`
arrays at the top of that file — that is the only place they appear.

Use `npm run ping -- <barcode> [analyzerId]` to see the raw body next to the
normalized order; add `--ack` to exercise acknowledge, `--post CODE VALUE` to
exercise the results upload.
