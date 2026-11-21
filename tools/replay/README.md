# Replaying a real month

```bash
tools/replay/run.sh ~/Downloads/KIBOGA_STATION__OCTOBER__2026.xlsx 2026-10
```

Reads the station workbook, replays every block of its SALES sheet as an FCMS
shift through the real functions on a moved clock, then writes
`tools/replay/out/station-<month>.md`. That file puts FCMS's litres, stock
variance and cash beside the workbook's, day by day, and lists every
assumption the replay had to make and every place the workbook says something
FCMS would have stopped or flagged.

The workbook's figures stay on your machine. The report names real credit
customers, so share it only with people who may see the books.

| file | does |
|---|---|
| `extract_station.py` | reads SALES, PMS, AGO, BANKING, INVOICES and RECIEVED into daily records |
| `kiboga_station_seed.sql` | the station as the workbook shows it: 3 tanks, 2 pumps, 10 nozzles |
| `replay_station.py` | one FCMS shift per SALES block (BOTH, or DAY + NIGHT on a price-change day) |
| `reconcile.py` | FCMS against the workbook, from what FCMS stored |

What the replay cannot do yet: the **depot** workbook (dispatches, depot meter,
transfers to the station). The station's receipts are treated as deliveries
from the depot.
