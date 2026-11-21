# TEST IT

Nine things, in the order you asked for them. Every step says what you should
see. Where a number depends on what the screen shows you, the arithmetic is
written out so you can check it in your head.

Sign in as **`SUP01`** / `ChangeMe123!` unless a step says otherwise.

---

## What the seed already put there

| | |
|---|---|
| Station | Kiboga Town, 2 tanks, 3 pumps, 9 nozzles |
| PMS tank | opens at **10,949.6 L**, price **5,180/L** |
| AGO tank | opens at **17,660.1 L**, price **4,990/L** |
| Open shift | tonight's NIGHT shift, opened 4 hours ago, 4 nozzles manned |
| Attendants | Moses Kato, Alice Nakato, Peter Okello, Sarah Achieng |
| Tender channels | MTN Mobile Money, Airtel Money, Visa/Mastercard, Fuel Voucher |
| Yesterday | closed and approved, one attendant 40,000 short |

Dips are entered in **litres**, straight off the chart on the office wall. The
system asks for no millimetres anywhere and does no conversion, so every figure
below is one you can check by subtraction.

---

## 1. Assign a pump attendant

The night shift already has four. To see the assignment flow, use **handover** —
which is what actually happens when someone goes off duty mid-shift.

**Station → Test / draw / handover → Handover tab.**

Pick Moses's nozzle, hand to **Sarah Achieng**, enter a meter reading.

**Expect:** one reading recorded, used twice — as Moses's close and Sarah's
open. That is the point: there is no gap between them where fuel could go
unaccounted.

> To build a roster from scratch you need a shift that is not open. Close this
> one first (step 4), then **Open a shift** — dips first, then nozzles.

---

## 2. Enter a credit customer

**Office → Credit customers → Add.**

```
Code             KIB-04
Name             Mubende Haulage Ltd
Phone            +256772000004
Credit limit     15000000
Payment terms    30
```

**Expect:** appears immediately with **15,000,000 headroom** and a zero balance.

Then **Station → Credit sale** and bill fuel to them:

```
Nozzle           any PMS nozzle
Litres           200
```

**Expect:** **200 × 5,180 = 1,036,000 UGX**. There is **no price field** — the
price comes from the shift. A supervisor cannot under-bill a customer and leave
the attendant carrying the difference.

**Then check Credit in the top bar.** Mubende Haulage now shows **1,036,000**
outstanding, **13,964,000** headroom, ageing in the *under 30 days* column.

---

## 3. Enter a discount

**Station → Test / draw / handover → Discount tab.**

```
Attendant        Moses Kato
Amount           25000
Reason           Fleet arrangement, agreed with the manager
```

**Expect:** accepted, and it will appear on Moses's cash-up at close as a
**settlement line** — not as a reduction in what he sold. He still pumped the
fuel; the station agreed not to collect 25,000 of it.

---

## 3b. Drop cash in the safe

**Station → Shift Operations → Cash drops to the safe.** You are preselected as
witness. Record **Moses, 2,000,000, book p.1 l.1**, then a second drop with a
typo, say 50,000. Void the typo with a reason: it stays on the list, struck
through. It is never edited and never counted.

**Expect:** under Moses, `UGX 2,000,000 dropped`. Try choosing an attendant as
witness: refused. At close, Moses's card says **Already dropped: UGX 2,000,000 ·
1 drop**. Enter only what he still holds. The most an attendant carried
(their largest drop, or the cash at close) over the cap — UGX 500,000 by default
— raises a CASH_HELD_OVER_CAP warning. One big drop at the end does not help:
it shows the whole shift's cash was carried.

## 3c. Agree a customer price

**Credit customers → Prices** on Nsamizi Transporters, as `MGR01`. Choose AGO,
**Pump ±**, `80`, reason `Credit terms`. It shows what the customer pays today.
Then record a credit sale to them on Shift Operations.

**Expect:** the sale is billed at pump + 80. At close the attendant's card still
balances: credit at the agreed price, plus an agreed-price line for the
difference. As `SUP01` the Prices form is refused. That is a manager's call.

## 3d. The books

**Reports → Books & Reconciliations**, as `HO01`.

**Expect:** *Reconciliations* shows every control agreeing: the trial balance,
receivables, each tank to the litre, cash, payables. *Receivables* ages each
customer. Their open-shift credit sits in its own column until the shift
closes. *Trial balance*: debits equal credits; click an account for its ledger.
*Journals*: open one to see its lines; *New manual journal* refuses one that
does not balance. As `SUP01` the Books are refused.

*Bank & mobile money*: pick the bank account, **Import statement** with a CSV
(date, description, reference, amount), then **Match automatically**. What is
left shows in two columns. Tick a book line and a statement line of the same
amount and **Match selected**; on a bank charge press **post**, choose 6100
and it disappears from both. **Move money** from the MTN wallet to the bank with
a fee: the wallet falls by amount + fee, the bank rises by the amount.

## 4. Close the shift — the main event

**Station → Close shift.** Four tabs, and a progress line at the top reading
`Meters 0/4 · Tanks 0/2 · Cash 0/4`.

### 4a. Meters

Each card shows **"opened at N"**. Add a known quantity so you can check the
arithmetic:

| Nozzle | Add | Litres through |
|---|---|---|
| Moses's PMS nozzle | **+500** | 500 |
| Peter's PMS nozzle | **+300** | 300 |
| Alice's AGO nozzle | **+400** | 400 |
| Sarah's AGO nozzle | **+200** | 200 |

Press **Enter** after each — focus jumps to the next box, so you can read eight
meters without touching the screen.

Leave the **electronic head** blank on three and enter the *same* closing figure
on one. That one will show zero divergence; the others show `--`.

**Expect under each card:** `500 L through this nozzle on Moses's watch`.

### 4b. Tanks — this is where you see the loss

PMS sold = 500 + 300 = **800 L**. AGO sold = 400 + 200 = **600 L**.

**A perfect dip, no loss** — just subtract what was sold:

```
PMS:  10,949.6 - 800 = 10,149.6 L
AGO:  17,660.1 - 600 = 17,060.1 L
```

Enter those and press **Check the numbers**.

**Expect:** both tanks green, variance ≈ **0.0 L**, `Dip agrees with the books`.

**Now make a loss.** Change the PMS figure to **10,094 L** — 55.6 litres lower.

```
10,094 - 10,149.6 = -55.6 L short
55.6 / 800 sold   =  6.95%
```

**Expect:** the card turns **red the moment you type it**, showing **-55.6 L**
and the percentage, and demands a reason. It is outside tolerance on both
tests — the litre floor and the percentage.

Type a reason under 10 characters. **It refuses.** Type a real one.

### 4c. Cash — what each attendant owes you

Moses sold **500 × 5,180 = 2,590,000**, less his **25,000** discount, so he owes
**2,565,000**.

Enter his settlement:

```
Cash                1,565,000
MTN Mobile Money      600,000
Airtel Money          300,000
Visa / Mastercard     100,000
```

That totals **2,565,000**. **Expect: balanced, green.**

**Now break it deliberately.** Change cash to **1,465,000** — 100,000 less.

**Expect:** refused, in the database's own words, naming Moses and the exact
amount unallocated. **Nothing is saved.**

### 4d. Declare the shortage

Leave cash at 1,465,000 and enter a shortage reason: `Short at count, agreed with attendant`.

**Expect:** the sheet balances again — **100,000 becomes a receivable against
Moses**, not a hole in the books. Sales = cash + mobile money + card + credit +
discount + shortage. That equation is what the close enforces.

Do the other three attendants the same way, without shortages.

### 4e. Commit

**Check the numbers** first — it runs the real close inside a savepoint and
rolls it back, so what you see is what will happen.

Then **Close the shift**.

**Expect:** a summary, and a link to **print the certificate**.

---

## 5. What you should see afterwards

**Certificate** — meters as opening *and* closing so the arithmetic can be
checked by hand, tanks with variance, settlement per attendant, signature lines.

**Station** — a red **STOCK_VARIANCE** exception for the PMS tank. Resolve it;
it will not accept fewer than ten characters.

**Today** — litres, revenue, gross margin, and **after expenses**. The two differ
by expenses, discounts, own use and stock loss.

**Losses → Per product** — PMS shows roughly **-55 L**, valued at cost, and
`Down on 1 of N days measured`.

**Losses → Running total** — the cumulative column. Yesterday's AGO variance
plus tonight's PMS loss, accumulating. **One bad night is noise; a line that only
goes one way is not.**

**Credit** — Mubende Haulage at 1,036,000, and Moses's 100,000 shortage under
Office → Shortages.

---

## 6. Cash on hand, broken down

**Operations → Banking.**

**Expect:** the cash position — what was collected, what was banked, and the
gap. Yesterday's 11,000,000 is banked and the rest is not, so there is a real
difference to look at rather than a tidy zero.

Mobile money and card are **not** cash on hand. They settle to the bank
directly, which is why the close records them as separate tenders rather than
lumping everything into one figure.

---

## If a screen errors

Tell me **which screen** and **the red text**. If the API terminal shows a
`warn:` line at the same moment, that line names the exact column or constraint
— paste it and I will have the cause rather than a guess.
