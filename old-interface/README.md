# Old Interface

This folder controls the **Old Interface** — the previous lab integration that
`Lab-Interface` replaces. Its code still lives at `E:\API_Integration`; only
its ability to start by itself has been taken away.

It is **retired, not deleted**. Nothing here runs unless a person deliberately
runs it.

## What was retired

Three Windows services, stopped and switched from `Auto` to `Manual` start:

| service | executable |
| --- | --- |
| `Results` | `E:\API_Integration\Services\Results\Results.exe` |
| `Orders_Prod_CBC` | `E:\API_Integration\Services\Orders\Orders.exe` |
| `Filter_Data_CBC` | `E:\API_Integration\Services\Filter_Data\FilterPatientData.exe` |

Three logon shortcuts, moved out of the Startup folder into
[`startup-disabled/`](startup-disabled/):

| shortcut | analyzer | executable |
| --- | --- | --- |
| `Vitros250 - Shortcut.lnk` | VITROS 250 | `E:\API_Integration\Devices\250\Vitros250.exe` |
| `Vitros_ECiQ - Shortcut.lnk` | VITROS ECi/ECiQ | `E:\API_Integration\Devices\ECiQ\Vitros_ECiQ.exe` |
| `Lab Integration - Shortcut.lnk` | Erba H360 | `E:\API_Integration\Devices\H360\Lab Integration.exe` |

The shortcuts are kept rather than recreated from scratch so the original
targets and working directories survive exactly as they were.

## Why it must stay down

The Old Interface and Lab-Interface talk to the same three analyzers and the
same HMIS. Running both means two systems competing for one serial link and two
systems posting results for the same sample. The VITROS 250 half of the Old
Interface was already failing for this reason before it was retired — its log
ends on `SendDetails: FAILED - The port is closed`, because the Moxa NPort had
been switched from Real COM to TCP server mode for Lab-Interface.

## Starting it by hand

Only when you actually want to fall back to it, and only after stopping
Lab-Interface first with `Lab-Interface-stop.bat`:

- `START-Old-Interface.bat` — starts the three services (prompts for admin) and
  the three device programs.
- `STOP-Old-Interface.bat` — stops all of it again.

Neither script re-registers anything for auto-start. After a reboot the Old
Interface is down again, which is the intended behaviour.
