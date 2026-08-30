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
  - `equipmentId` — optional numeric HMIS id, used as a fallback in the
    acknowledge body and the results upload when a pending row omits it.
  - `siteId` / `showCulture` — optional pass-through query parameters.
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
