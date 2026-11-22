# Shift math, and how it is proven

A shift is closed by `fn_close_shift`, a depot day by `fn_close_depot_day`.
`tools/audit/shift_math.sql` then recomputes every closed shift from what was
recorded, and compares. It calls none of the functions it checks.

```bash
psql -d fcms -f tools/audit/shift_math.sql            # stops on any difference
psql -d fcms -v strict=0 -f tools/audit/shift_math.sql  # report only
psql -d fcms_check -f db/test/shift_math_scenario.sql   # the paths the demo never takes
```

CI runs it on the business scenarios, every simulated month and the demo.

## Before a shift can close

The close refuses (730) until:

* every nozzle is read on **both meters**, electronic and manual, at opening,
  handover and close -- an opening carries both from the nozzle's last close;
* the litres on the electronic head match the manual meter's to within
  **1 L** (`tenant_policy.meter_pair_tolerance_litres`). Beyond it the close
  stops unless the supervisor says why; then it closes, flagged CRITICAL;
* every tank is dipped, and no delivery is still being decanted unreceived;
* everyone who sold has a cash-up, and **every shortage has a reason**. The
  preview shows a shortage without one, so the supervisor learns who is short
  before being asked why.

## The arithmetic

Per attendant's holding of a nozzle (from assignment to handover or close):

| | |
|---|---|
| litres metered | closing - opening; past the wrap point only if the rollover was ticked |
| litres sold | metered - pump tests - own use - returned to tank, each counted in that holding's window |
| fuel owed | each sale line: round(litres sold x the shift's captured price, 2) |

Per attendant's cash-up, as the close screen shows it:

```
metered (manual meter)
  - pump tests - own use - returned to tank   = litres sold
litres sold x price                           = fuel sold
fuel sold + shop sales
  - mobile money - card and vouchers
  - credit sales - agreed-price differences
  - discounts - cash dropped in the safe      = cash expected at close
cash expected - cash counted                  = short (+) or over (-)
```

Returns to tank are LITRES: they come off before pricing, never off the cash.

```
owed     = fuel owed + shop sales they made
settled  = cash at close + witnessed drops + mobile money, card, vouchers
         + credit sales (at the customer's price)
         + agreed-price differences (pump value - customer's price)
         + authorised discounts
owed - settled > 0  ->  a shortage against that attendant, by name
owed - settled < 0  ->  an overage
```

Every cash-up nets to nil. So does every shift:
`fuel + shop = cash + electronic + credit + agreed + discounts + shortage - overage`
-- the Sales & Payments tab of Shift Reports shows it row by row.

Per tank, per shift:

```
the tank loses   what its meters counted, and bulk draws
gets back        returned pump tests and returns to tank  -- once each
variance         = (this closing dip - the previous closing dip)
                 - everything booked between the two closes (stock-take adjustments aside)
```

A variance is flagged when it is over the litres cap, or over the percentage
of litres sold, and outside what a dipstick can read (stations: the noise
floor; depot days: no floor, percentage of the day's loads by the depot's own
clock).

## The 26 rules

| | |
|---|---|
| M1-M5 | every holding has both readings and one meter event; litres = closing - opening; a reading below its opening only as a ticked rollover; each holding opens where the last closed; the electronic head's litres match the manual meter's to within 1 L, or a CRITICAL flag carries the reason |
| D1-D3 | every litre classified; sold = metered - tests - own use - returns; each classified to the litre |
| P1-P2 | priced at the shift's captured price; a price for everything sold |
| K1 | credit: litres x unit price; pump price = the shift's; no agreement means pump price |
| C1-C6 | fuel and shop charged; drops, credit, agreed prices, discounts settle what was recorded; shortage = owed - settled, against the right person; every cash-up nil; everyone who sold has a cash-up |
| T1-T2 | the tank's movements, once each, net of corrections; every variance outside tolerance flagged at its true size, none inside |
| J1-J3 | one standing journal per approved shift; its sales, cash, credit and shortages are the shift's; the books leave the tank at its dip |
| B1-B3 | a bulk sale is litres x price and leaves its tank once; a transfer leaves one tank and arrives in the other |
