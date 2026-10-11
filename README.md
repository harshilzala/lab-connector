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

| | `atellica` | `maglumi` | `sysmex` |
|---|---|---|---|
| O records | one, all assays repeat-delimited | **one per assay** | one |
| Universal Test ID | `^^^CODE^^^1` (rank/dilution required) | `^^^CODE` | **`^^^^CODE^1`** (code in component 5) |
| O fields 12 + 16 | report type `O` + specimen descriptor | **omitted** | report type in field **26**: `Q` on a query reply, `O` on a push |
| Specimen id on a query reply | bare barcode | bare barcode | **echoed verbatim** (padded sample no. `^rack^tube`) |
| P record (no demographics) | `P\|1\|\|\|\|\|\|\|` | `P\|1` | `P\|1` |
| H version / password | `LIS2-A2` / *(empty)* | `E1394-97` / `PSWD` | `E1394-97` / *(empty)* |
| H timestamp | `YYYYMMDDHHMMSS` | **`YYYYMMDD`** (date only) | `YYYYMMDDHHMMSS` |

```
atellica   O|1|1234567||^^^CA125^^^1\^^^CA153^^^1|R|||||||O|||Serum
maglumi    O|1|1234567||^^^CA125|R
           O|2|1234567||^^^CA153|R
sysmex     O|1|   SF2609160001^A1^3||^^^^URI^1|R||||||||||||||||||||Q
```

`vitros-eciq` is the fourth entry (see the dialect library). The `sysmex`
layout (UF-4000 / UF-5000, UC-3500, U-WAM) is the Sysmex XN/UF/UC family
convention and is **not yet confirmed on a wire capture** — see
[SETUP-SYSMEX-URINE.md](SETUP-SYSMEX-URINE.md) for the commissioning checklist.

Add a machine by adding an entry to `ORDER_FORMATS` in
[`src/codec/astm/records.ts`](src/codec/astm/records.ts) — the config enum
derives from that table, so nothing else changes.

`npm run dialects` replays the captured Snibe Maglumi wire logs through the
codec and diffs the generated download against the vendor spec.

### VITROS 250 (Kermit)

The VITROS 250 does not speak ASTM on its host port: sample programs and
results move as small named files over the **Kermit** file-transfer protocol
(`protocol: "kermit"`). The link in `src/codec/kermit/` follows Ortho's
*Specifications for Laboratory Computer Interface* (Part No. 355283, ch. 5),
and three of its rules are easy to get wrong:

- **NAK ZERO.** The analyzer at the Cancer Centre has download solicitation
  on: whenever it is idle and can accept sample programs it sends an `N`
  packet with sequence 0 once a minute (the legacy capture holds 372 of them).
  It is a poll, not a NAK of anything we sent, and must never be answered. An
  unsolicited `Y` in reply is a "valid packet, wrong place", after which the
  analyzer rejects the next send-init with `0005 INVALID PACKET USAGE`. Before
  this was understood, every first download after ~2 minutes of quiet failed
  that way (29 of 57 on 2026-09-11) and succeeded only on the retry. The
  solicitation is now surfaced as `lastSolicitAt` in the analyzer status and
  closes the download breaker, since it is proof the instrument is receptive.
- **One session at a time.** An upload is "in progress" from the analyzer's
  `S` to its `B`, not from its first data packet; a download must not start
  inside that window, and if the two send-inits genuinely cross, the analyzer
  yields to the host (§5.6.7) — the host just waits for its `Y`.
- **Busy is not broken.** `E 0000 RECEIVER BUSY` means "try again after a
  minute"; `E 0002 RECEIVER DISABLED` means an operator has turned RECEIVE
  TESTS off at the console. Neither counts toward the download breaker.

Set `logLevel: "debug"` to get one log line per Kermit packet in each
direction — the only way to see *why* the analyzer sent an `E` packet.
`npm run vitros:link` pins the behaviours above; `npm run vitros:pacing`
the per-packet timing; `npm run kermit:corpus` replays the site's capture.

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
- `hmis.mode` / `hmis.use` — which HMIS the analyzers use: HINAI, GenX
  (`hmis.genx`), or both side by side. Leave them out and the legacy
  `hmis.api` decides, as before. See [HMIS: single or both](#hmis-single-or-both),
  and read [Upgrading](#upgrading) before changing the mode on a running site.
- One entry per analyzer under `analyzers[]`:
  - `profile` — the instrument **model**, from the machine profile library in
    `src/profiles/index.ts` (`mindray-bc5150`, `mindray-bc6000`, `erba-h360`,
    `lifotronic-gh900plus`, `vitros-eciq`, `vitros-250`, `snibe-maglumi`,
    `sysmex-uf4000`, `sysmex-uc3500`, `sysmex-uwam`
    …). The profile supplies every model-level default — protocol, transport
    type/mode/port, ACK conventions, the analytes the instrument reports, the
    channels that are not results — so the same model at a second site is just
    its identifiers:

    ```jsonc
    { "id": "site-bc5150", "profile": "mindray-bc5150",
      "equipmentCode": "XXXX001", "transport": { "host": "10.x.x.x" } }
    ```

    Any key written in the block wins over the profile (objects merge one level
    deep; arrays and scalars replace). Optional — a block without `profile` is
    read exactly as before. **Adding a new model means adding a profile**, with
    the vendor document or wire capture each number came from, not copying a
    block between sites.
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
    `excludeTestCodes` restricts which *assay codes* are programmed: listed
    codes are left out of every download (their rows are still cached and a
    result for them would still be joined). Use it for a test HMIS lists under
    the machine that the instrument does not have — the VITROS 250 drops a
    whole sample program that names an assay it lacks (HMIS's derived LFT
    values 107/108/109), leaving the tube "not programmed".
    On the VITROS 250 every download carries the *whole* panel, because the
    instrument keeps one program per sample and a later download replaces it.
  - `sendDate` — send today's date (`dd-MM-yyyy`) as the `date` parameter.
    Default **false**, so an order raised yesterday for a tube run today is
    still found.
  - `transport` — `tcp` (`mode: server` means the analyzer dials in) or `serial`.
  - `sendDemographics` — default **false**; send only barcode + tests to the
    analyzer (recommended for privacy). Turn on only if the analyzer needs it.
  - `qc.sampleIdPrefixes` — barcodes starting with these are treated as QC, not
    patient results.
  - `allowTestCodes` — the ONLY analyzer codes this interface files (empty =
    no allow-list). It scopes both directions: result values outside it are
    dropped at delivery, and **pending rows HMIS offers for parameters outside
    it are ignored** — not stored, not counted as waiting, not acknowledged.
    Codes mapped through `testCodeAliases` count under either spelling. This
    is how the BC-6000 is held to its 22 interfaced CBC analytes while HMIS
    raises rows for 38.

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

## IM: orders out, results in

Every machine above is reached directly. **IM** is not a machine: it is the
instrument middleware in front of the chemistry / immunoassay line, and it runs
the tubes on the analyzers itself. It never asks the LIS for work — it listens
on a TCP port and takes every order sent to it. That feed came from a Mirth
channel. With `hl7.orderPush` the connector reads those orders from HMIS itself
and sends them to IM, and takes the results back on a second connection:

```
                       ORDER channel  — the connector dials IM (transport)
HMIS  GET /mirth/pending?eqCode=EQ0022&siteId=…   (the ordinary order poll)
        │  one row per pending test, grouped per tube
        ▼
  order store ──► ORM^O01 over MLLP ──► IM ──► the analyzers
        ▲                                │
        └──── marked downloaded ◄─────────┘ only when IM answers MSA|AA

                       RESULT channel — IM dials the connector (resultTransport)
  IM ──► ORU^R01 over MLLP ──► result store ──► joined to the order rows
                                                  │
HMIS  POST /mirth/labresult  ◄────────────────────┘ then POST /mirth/acknowledge
```

Both channels belong to **one** analyzer block — one equipment code, one order
store — which is what lets a result that arrives on one connection be filed
against the order that left on the other.

- **One message per tube**, each test its own ORC/OBR pair, the barcode in both
  the placer and the filler order number, the specimen type in OBR-15 and the
  priority in OBR-5 and OBR-27. Demographics ride along when
  `sendDemographics` is on, so IM's worklist shows a name.
- **Acknowledged or not sent.** The order is written and then the link waits for
  IM's `MSA`. `AA`/`CA` marks the tube downloaded in the order store, so it is
  never sent twice. `AE`/`AR` is a **refusal**: the tube is *not* marked, the
  reason IM gave is logged, the tubes behind it still go, and it is offered
  again after ten minutes rather than on every poll. No answer inside
  `ackTimeoutMs`, or a socket that drops, is a **link failure** and counts
  toward the ordinary download breaker (three in a row suspends pushing for a
  doubling interval while polling continues).
- **Orders go one at a time.** The next is not written until the one before it
  has been answered, so two tubes never share the line.
- **Nothing is acknowledged to HMIS at download.** As everywhere else, a pending
  row is retired only once a result has been filed against it.
- **Results come back on their own connection.** `resultTransport` is a
  listener: IM dials it and delivers `ORU^R01`, each acknowledged with
  `MSA|AA`. The barcode is read from OBR-3 (OBR-2 as the fallback) and the test
  code from OBX-3, and every OBX value type is accepted — this line reports
  screening assays as words ("Non Reactive"), which a numbers-only filter would
  drop. A value files only against a pending row HMIS raised for that barcode
  and that identifier; anything else waits as unmatched. Nothing but
  acknowledgements is ever sent on this channel. The listening port is this
  PC's choice (10012 by default): IM's result connection has to be pointed at
  it, or the block given the port IM already uses.
- **Both channels are on the console.** The Auto Certify page opens with an
  *Order channel* and a *Result channel* card: where each connects, whether the
  link is up, how many tubes IM accepted, refused or left unanswered, how many
  are still waiting to go, how many result messages and values came back, and
  the last tube in each direction. That page does not show where the certify
  job connects — the portal URL and the HIS database are neither rendered nor
  sent to the browser.

The whole machine is one profile: `"profile": "im"` supplies HL7 over MLLP,
`transport` client mode on port 10011, the result listener on 10012, the poll,
and the push. A site block is the address and the equipment code:

```jsonc
{
  "id": "im",
  "profile": "im",
  "equipmentCode": "EQ0022",
  "siteIds": ["2", "13873256", "5866265", "14", "2567859"],
  "transport": { "host": "10.11.4.231" },                // ORDER channel: dial IM
  "resultTransport": { "type": "tcp", "mode": "server",  // RESULT channel: IM dials in
                       "host": "0.0.0.0", "port": 10012 }
}
```

**Before turning it on, stop the Mirth channel that feeds IM** — two systems
sending the same orders puts every tube on IM's worklist twice.

**Commissioning.** The message layout is the HL7 v2 standard one; it has not
been read off a capture of the Mirth feed, so IM's own acknowledgement is what
confirms it. Send one tube, watch the wire log on the dashboard, and read the
`MSA`. If IM refuses it, the reason is in the log and everything that might
differ is a setting rather than an edit: `messageType` (`ORM^O01` or `OML^O21`,
which adds an SPM specimen segment), `version` (MSH-12), `receivingApp` /
`receivingFacility` (MSH-5/6), `processingId` (MSH-11), and `sendingApp` /
`sendingFacility` (MSH-3/4). `npm run im:orders` pins the message, the
acknowledgement handling and the poll behaviour; `npm run im:channels` runs
the whole connector against a stand-in HMIS and a stand-in IM, both channels
and the console page included.

### The `im` block

IM can be written as one top-level `im` block instead of an analyzer entry.
Use one or the other: the same equipment code twice is refused. The loader
turns the block into an ordinary `"profile": "im"` analyzer before profiles
are applied, so the order push, refusal retry, result channel and console
cards are the ones described above. The block only holds what differs per
site.

| Key | Meaning |
|---|---|
| `enabled` | `false` (or no `im` block) means no IM from this block. Lets the block stay parked in the file. |
| `id` | Analyzer id, which names `spool/<id>/` and the console card. Default `im`. |
| `equipmentCode` | **Required.** The `eqCode` HMIS raises IM's orders under. |
| `equipmentId` | HMIS equipment id. Fallback in the acknowledge and upload bodies. Required when `autoCertify.hinai` is on. |
| `siteIds` | HINAI sites polled for IM's orders. GenX ignores them because its worklist comes as one batch. |
| `hmis` | IM's own lanes: `{ "mode": "single", "use": "hinai" }`, `{ "mode": "single", "use": "genx" }` or `{ "mode": "both" }`. Absent means the top-level `hmis` setting. |
| `orders.host` / `orders.port` | ORDER channel (`transport`): the address the connector dials to send IM its work. The host is required; the port defaults to 10011. |
| `results.host` / `results.port` | RESULT channel (`resultTransport`): where the connector listens for IM's results. Defaults to `0.0.0.0`, port 10012. |
| `autoCertify.hinai` | Adds `equipmentId` to the existing Oracle certify job (see below). Default `false`. |
| `autoCertify.genx` | Certifies IM's GenX result lines through GenX (sets the analyzer key `genxAutoCertify`). Default `false`. |
| `analyzer` | Any other analyzer key, merged **deeply** over everything above and the profile. This is the escape hatch. |

**Single HINAI** (IM as it runs today):

```jsonc
"im": {
  "enabled": true,
  "equipmentCode": "EQ0022",
  "equipmentId": 46150218,
  "siteIds": ["2", "13873256", "5866265", "14", "2567859"],
  "hmis": { "mode": "single", "use": "hinai" },
  "orders":  { "host": "10.11.4.231", "port": 10011 },
  "results": { "host": "0.0.0.0", "port": 10012 },
  "autoCertify": { "hinai": false, "genx": false }  // hinai: true also needs "autoCertify": { "enabled": true, ... }
}
```

**Single GenX.** `siteIds` is not needed. `hmis.genx` must name IM's services:

```jsonc
"hmis": {
  "genx": {
    "baseUrl": "https://genx.example-hospital.local",
    "serviceTests":      { "SVC01": ["TEST1", "TEST2"] },
    "equipmentServices": { "EQ0022": ["SVC01"] }
  }
},
"im": {
  "enabled": true,
  "equipmentCode": "EQ0022",
  "hmis": { "mode": "single", "use": "genx" },
  "orders":  { "host": "10.11.4.231" },
  "autoCertify": { "hinai": false, "genx": true }
}
```

**Both**, meaning orders from HINAI and GenX and results into each (see
[HMIS: single or both](#hmis-single-or-both)). The `hmis.genx` block above is
needed here too:

```jsonc
"im": {
  "enabled": true,
  "equipmentCode": "EQ0022",
  "equipmentId": 46150218,
  "siteIds": ["2", "13873256", "5866265", "14", "2567859"],  // HINAI only
  "hmis": { "mode": "both" },
  "orders":  { "host": "10.11.4.231", "port": 10011 },
  "results": { "host": "0.0.0.0", "port": 10012 },
  "autoCertify": { "hinai": false, "genx": true },
  "analyzer": { "hl7": { "orderPush": { "version": "2.5" } } }
}
```

**`analyzer` is merged deeply.** `{ "hl7": { "orderPush": { "version": "2.5" } } }`
changes only the version and leaves `orderPush.enabled` from the profile
switched on. Objects merge at every depth; arrays and scalars replace. An
ordinary analyzer block still merges with its profile one level deep, as
described under *Install & configure*. Only the `im` block's `analyzer` key
merges deeply.

**GenX needs `hmis.genx.equipmentServices` for IM.** HINAI filters its pending
list by equipment code on the server. GenX does not: an equipment code with no
`equipmentServices` entry gets every service on every tube. For a machine that
only answers host queries that costs nothing. For IM, which is sent every
order, it would put the whole lab's work on IM's worklist under codes IM does
not know, refused and retried forever. So when IM's lanes include GenX, the
config is refused until `hmis.genx.equipmentServices` lists IM's equipment
code with the serviceCodes it runs.

**Auto-certify.** Certification signs a result off with nobody reviewing it,
and it cannot be undone. Both switches are therefore off by default, and each
one acts only on its own system:

- **`autoCertify.hinai`** does not certify anything in the connector. It adds
  IM's `equipmentId` (as a string, once) to `autoCertify.equipmentIds`. The
  existing Oracle certify job then certifies IM's results exactly as it
  certifies the other equipment, and nothing else about that job changes. That
  job must be enabled. `im.autoCertify.hinai: true` with `autoCertify.enabled`
  not `true` is a config error that names both keys. If IM does not use the
  HINAI lane, the switch is ignored and logged once at start
  (`im.autoCertify.hinai ignored: IM does not use the HINAI lane`).

  The Oracle job is the old `Certify_Results` service (`Auto_Certify.exe`)
  ported clause for clause, with four changes taken from its own logs
  (22 Jun – 12 Oct 2026):
  - **The portal's answer is read, not just its HTTP status.** The portal
    answers HTTP 200 even when it did not certify:
    `{"Statue":"Fail","Error":"… optimistic locking failed …"}` — 155 times in
    the 35 days studied, all logged by the old service as successes. A call
    now counts as certified only when the body says `"Statue":"Success"`
    ("Status" and any case accepted; a body that is not JSON is judged by
    the HTTP status, as before). A failed one is found again and retried on
    the next run.
  - **`skipRecertifyHours`** (default 24): a row the portal confirmed is not
    called again for that long, even if the database still lists it as ready.
    The old service re-certified some every 30 s for hours — 2,794 extra calls
    for 30 results in 3–12 Oct. Logged once per row; 0 restores the old
    behaviour.
  - **Batched parameter lookups.** "Still pending?" and "which parameters?"
    are asked for every result of a run at once (two queries per 900
    results) instead of twice per result — 2 round trips to the HIS database
    instead of ~124 on the busiest run (62 results, 2026-10-05 12:00).
  - **`concurrency`** (default 1, max 8): results certified at the same time.
    1 keeps the old order exactly; the busiest run used about 7% of what one
    at a time can do, so raise it only if volume grows a lot. More parallel
    calls make the "optimistic locking" clash likelier. A result's own
    parameters always go one after another.
  - Keep `autoCertify.enabled` false while the old `Certify_Results` service
    runs: both together certify every result twice.
- **`autoCertify.genx`** runs inside the filer, after GenX has confirmed a
  results post. A GenX result line is one test line on GenX's side, and its id
  is the `labResultId` on the GenX order rows. A line is certified only when
  **every** test of that line has been filed in GenX against that line, and
  GenX placed every one of them. The list of tests is the line's full list
  from the GenX worklist, taken before the interface drops any code it does not
  carry. So a line with a test the interface never files, or with a test that
  was filed under another line, is never auto-certified. It is left for staff,
  and the connector logs it once. A line with a test that is still waiting, or
  that the operator skipped, is not certified either. When GenX answers a post
  with some codes `unmatched`, only the codes it placed count as filed in GenX.
  The unmatched codes stay pending and are retried like "no order row yet", and
  their line is not certified until they are placed. Certification is one call per line,
  `<autoCertifyMethod> <genx.baseUrl><autoCertifyPath>`, with the line id in
  `<autoCertifyParam>`. GET sends it as a query string and POST sends it as a
  JSON body. The defaults are `GET`,
  `/integration-service/external/v1/lab/equipment/autocertify` and
  `labresultid`. Only GET and POST are accepted. The call uses the same token,
  API key and 401 retry as the other GenX calls, and it is written to the GenX
  transaction log as kind `certify`. Certified line ids are recorded on the
  staged sample, so a line is never certified twice. A failed call never
  un-files anything. It is retried on a later pass (no more often than
  `passIntervalMs`) without re-posting the results. The same revisit covers a
  sample that was filed before the switch was turned on. The connector
  **never** certifies a line whose GenX rows came from the upgrade migration
  ([Upgrading](#upgrading)) rather than from a GenX response. Such a line is
  left for HMIS staff, and the connector logs it once.

  **A corrected value on a line that is already certified** (a rerun or
  correction after GenX certified the line) is **not** posted to GenX
  automatically. The connector cannot un-certify the line, so a person has to
  decide. The value stays pending in GenX with `GenX result line <id> is already
  certified — the corrected value needs staff; 'File now' sends it`, and a
  warning is logged. **File now** posts it to GenX and does **not** certify the
  line again. HINAI files the correction as it always has.

The Auto Certify page's IM cards show IM's HMIS mode and lanes, values filed
per system, held samples, and the GenX certified and failed counts with the
last certify error. As before, they show nothing about where the certify job
connects.

## HMIS: single or both

The connector can talk to two HMIS systems. Each one is called a **lane**.
`hinai` is the Zydus HIMS `/mirth/*` gateway (the keys at the top of `hmis`, or
inside `hmis.hinai`). `genx` is GenX LIMS (`hmis.genx`). JSON (status, API and
spool files) uses the names `hinai` and `genx`. The pages show them as HINAI
and GenX.

- **single** means one lane. Every analyzer behaves exactly as before,
  including its choice of `filing.mode`.
- **both** means HINAI and GenX side by side. It was added for IM, which the
  lab runs against both while GenX is brought in.

`hmis.mode` (`"single"` | `"both"`) and `hmis.use` (`"hinai"` | `"genx"`,
single mode only) set this for every analyzer. Any analyzer block, or
`im.hmis`, may carry its own `{ "mode", "use" }` that wins for that machine
alone. Without `mode`, the legacy `hmis.api` decides: `"genx"` means single on
GenX, and anything else means single on HINAI. So a config written before
these keys is read unchanged. `mode`/`use` win over `api` when both are
written. Each lane that any analyzer uses needs its base URL (`hmis.baseUrl`,
`hmis.genx.baseUrl`).

**What both mode does with orders.** Every poll reads both systems. HINAI is
read per site and per day as before. GenX is read once per tick, because its
batch ignores site and date. Each row is stored with the lane it came from. On
the first tick both systems are read before anything is pushed. The machine
gets **one order per tube** carrying the union of the tests both systems list,
and after that only new tests go out as a delta, as always. A tube that only
one system lists is still sent, because the tube has to run either way, and
the hold rule below applies to filing only. A host query and the console's
**Re-send** ask both systems and merge the answers.

**What both mode does with results.** Both mode always files through the
staged store, even when the analyzer says `filing.mode: "queue"`. In that case
the log says `both HMIS mode files through the staged store` once at start. The
reason is that a value has to be remembered per system, and only the staged
store can do that. For each sample, each system is handled on its own. The
values not yet filed in that system are joined against **that system's own
order rows**, posted with that system's own ids (identifier, `labResultId`),
and acknowledged to that system. A value is done once it is filed (or skipped
by the operator) in every lane. A rerun or correction replaces the value and
files it to both again.

**The hold rule.** A tube that only one system lists is **held**. Nothing is
posted anywhere. The Results tab shows `held: only in HINAI` (or GenX), and the
sample's error reads `order only in HINAI — waiting for GenX; "File now" sends
it to HINAI only`. There is no timer. If the connector quietly filed to one
system after a timeout, it would be deciding on its own that the other system
never gets the result, and that decision belongs to a person. The hold is
checked on every pass, and the tube files to both by itself the moment the
other system lists it. **File now** on a held sample sends it to the system
that has the tube. Each value is marked skipped in the other system, a warning
names the barcode, the system and the values, and the sample is complete. A
tube that **neither** system lists stays held, and File now cannot send it
anywhere.

**A test ordered in only one system.** The tube is in both systems but one of
its tests is listed by only one of them. That value files to the system that
lists it and waits for the other as "no order row yet", like any value whose
order is not raised yet. File now closes it: for each system that has the tube
but still no row for that test, the value is marked skipped there and logged.
File now skips a value only when that system has **no row at all** for the
test. A value that is withheld (its row is excluded) or ambiguous (two rows
could take it) is never skipped. It keeps waiting exactly as it would in single
mode, because skipping it would hide a problem someone has to look at. Apart
from those values and a tube in neither system, File now leaves the sample
complete.

**Patient mismatch.** Before filing a sample to either system, the connector
compares the patient id (UHID/MRN) each system gives for the barcode, trimmed
and ignoring case. If both give one and they differ, the sample is held and
**nothing is filed anywhere**. The sample's error reads `patient differs
between HINAI (<id>) and GenX (<id>) for this barcode — not filed; correct it
in HMIS`. **File now and Force both refuse it** with that message, because
sending a result past this check would put it on the wrong patient in at least
one system. File now answers HTTP 409 with the message, and the console shows
`File now refused: patient differs …`. Force refuses with the same message. Fix the registration in HMIS. The
check runs on every pass, and again just before each post if the rows were
refreshed mid-pass. The sample files normally once the ids agree. If either
system gives no id, there is nothing to compare and no check is made. The
machine order still goes out, so the tube still runs.

**`hmis.patientCheck`** (default `true`) switches this check on or off. The
two systems may number patients differently: HINAI may give an MRN where GenX
gives a UHID. If they do, every both-mode sample would be held as a mismatch.
Before going live in both mode, compare the ids on a few real tubes in the two
transaction logs. Set `"patientCheck": false` only if the numbering really
differs. While the check is off, the connector logs a warning at every start:
`hmis.patientCheck is off — in both HMIS mode a sample is filed even when
HINAI and GenX name different patients for its barcode`.

**When one system fails.** A system that is down or refuses a post does not
stop the other one. Its error is recorded per lane and shown on the dashboard,
whose HMIS line reads `HINAI + GenX (both)` with each lane's state. That
system is retried on the next pass. Whatever the other system already took is
not undone and is never posted to it again. A GenX outage never slows or
stops HINAI filing. While a system is marked down, the connector skips only
its network calls: lookups, posts, acknowledges and certifies. The order rows
already cached for it still count for the hold rule and the join. So a tube
that the cache shows in both systems files to HINAI and stays pending for GenX.
It is not held and does not turn into an error.

**Force** (password as always) works per system, each from its own cached
rows, and reports one entry per system. It refuses a patient mismatch.

**Logs, one per HMIS.** HINAI always writes `hmis.auditLog`
(`logs/hmis-YYYY-MM-DD.log`). When HINAI is also in use by any analyzer, GenX
writes its own `hmis.genx.auditLog` (`logs/hmis-genx-YYYY-MM-DD.log`), so the
two systems' evidence trails stay apart. When GenX is the only lane any
analyzer uses, it keeps writing to `hmis.auditLog` as before. This is decided
by the lanes the analyzers actually use, not by which blocks are filled in. To
trace a tube in both mode, search both families:

```
findstr <barcode> logs\hmis-2*.log logs\hmis-genx-*.log
```

### Upgrading

Order rows that older versions stored carry no lane, because there was only
ever one. The new version labels them **once**, on its first start, and never
guesses again. When it has done this, it writes `spool/<id>/orders/.lanes.json`.

1. **Start the new version in the HMIS mode the site already runs.** For a
   HINAI site, that means single mode on HINAI, which is what an unchanged
   config gives. Every old row is then labelled with that lane and marked
   `migrated`, and everything carries on as before.
2. **Change the mode only after that first start**: edit the config and
   restart.

If the first start is already in **both** mode, the connector cannot tell
which system an old row came from. Those rows are **quarantined**. They stay
on disk but are never used to file, acknowledge, certify, Force, or rebuild
another row. The log warns once per analyzer with the count: `cannot tell which
HMIS these old order rows came from — start the new version in the mode the
site ran before, then switch`. Tubes that HMIS still lists come back on the
next poll with their lane. A tube whose rows were already acknowledged (a
rerun of an old sample) cannot be filed by the connector and has to be
entered in HMIS.

GenX auto-certify never certifies a line from `migrated` rows. A wrongly
labelled row must not certify an unrelated line, and certification cannot be
undone.

**Results filed before a switch.**

- **Single to both**: values that were complete before the switch stay
  complete and are **not** sent to the newly added system. This avoids a flood
  of old results into it. Only values received or rerun after the switch file
  to both systems.
- **Both to single**: values that were waiting only for the system no longer
  in use stop waiting and count as complete. A sample held for that system is
  released and files normally to the remaining one.

**One system down in both mode.** The poll and a host query answer with the
systems that answered. The machine gets the tube with those tests. The down
system's tests go out later as a delta, once it answers again. A tube known so
far only to the system that is up is held for filing until the other one lists
it (see the hold rule).

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

  **Force** ("Results" tab, shown on a sample once HMIS has taken at least one
  of its values — filed or partly filed) pushes *every* value of that sample to
  the HMIS results endpoint again, **without** asking HMIS for its pending
  rows: parameter ids come from the order rows already cached for the barcode
  and the parameter catalogue, values that resolve to nothing are listed back
  rather than guessed, and the rows sent are acknowledged as usual. It exists
  for the day HMIS withdraws a sample's rows before the interface has filed
  them (PL2609120001, 2026-09-12). Because it writes patient results past the
  normal proof that HMIS asked for them, it asks for the password in
  `Force_Hmis.password` every time and is logged on every use; with the
  password empty the button is not shown.

The Cancer site runs the ABL9 and the BC-6000 staged and both VITROS queued.
Switching an analyzer to staged migrates whatever its queue still holds into
the store on the next start, so nothing already received is lost. What the
queue had already *delivered* is gone from disk, though — a queued analyzer
kept nothing once HMIS accepted an upload — so those samples are not on the
console and cannot be Forced. `npm run import:filed` (`-- --days N`,
`-- --analyzer <id>`) restores them from the HMIS transaction log
(`logs/hmis-<day>.log`): every accepted upload's rows come back as filed
values, under the analyzer's own code, latest upload first. It only adds
(a value the store already holds is never touched), it is safe to run twice
and while the service is up, and it refuses an analyzer with `testCodeScale`
because the log holds values after scaling. Shela moved the ECi and the 250
to staged on 2026-09-19 and ran it for the two days before.

## Log & spool retention

Four things grow on disk. Each is bounded, but by a different mechanism.

| What | Where | Bounded by |
|---|---|---|
| HMIS transaction log | `logs/hmis-YYYY-MM-DD.log` | one file per day, deleted after `retention.logDays` (30) |
| GenX transaction log (only while HINAI is also in use) | `logs/hmis-genx-YYYY-MM-DD.log` | the same |
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
