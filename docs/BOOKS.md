# The books

FCMS keeps a double-entry general ledger. Nobody keys it in: every shift,
delivery, payment and expense posts its own journal **in the same transaction
as the event**. If the event is saved, its journal is too; if one fails, both
do. This page says what posts where, and how each control is reconciled.

Migrations: `610_general_ledger.sql` (the ledger and the postings) and
`620_books_reports.sql` (reports, reconciliations, period close).
Screen: **Reports → Books & Reconciliations**. API: `/api/books/*`.

## Rules that never bend

* **Every journal balances.** Debits equal credits, checked by the database at
  commit. A journal that does not balance is refused.
* **Nothing is edited or deleted.** A mistake is *reversed*: a new journal
  that undoes the old one line for line, with a reason. Both stay visible.
* **The app cannot write the books.** Only the posting functions can, running
  as the `fcms_ledger` role. The API reads the books, posts manual journals
  and reversals, and closes months, all through functions that check who is
  asking.
* **A closed month takes nothing more.** An event dated in a closed month
  posts to the first open month after it, and keeps the date it happened.
* **Control accounts name their party.** A line on receivables names the
  customer, on payables the supplier, on fuel stock the tank and litres. So
  every control account carries its own sub-ledger.

## The chart of accounts

Seeded for every company. A company may add accounts; the postings use these.

| code | account | type | sub-ledger by |
|---|---|---|---|
| 1000 | Cash on hand (tills and safes) | asset | site |
| 1010 | Bank | asset | |
| 1020 | Mobile money: awaiting withdrawal | asset | channel |
| 1030 | Card settlements due | asset | channel |
| 1040 | Fuel vouchers due | asset | channel |
| 1100 | Trade receivables: credit customers | asset | customer |
| 1110 | Staff shortages recoverable | asset | staff member |
| 1190 | Other receivables | asset | |
| 1200 | Fuel stock | asset | tank, in litres |
| 1210 | Shop stock | asset | item, in units |
| 2000 | Trade payables: suppliers | liability | supplier |
| 2010 | Goods received, not yet invoiced | liability | |
| 2050 | Contra settlements | liability | |
| 2200 | Inter-site transfers in transit | liability | site |
| 2300 | Wages payable (deductions) | liability | |
| 3000 | Owner's equity and opening balances | equity | |
| 3100 | Retained earnings | equity | |
| 4000 | Fuel sales | income | |
| 4010 | Shop sales | income | |
| 4020 | Other income | income | |
| 4090 | Discounts and agreed-price allowances | income (contra) | |
| 4100 | Cash overages | income | |
| 5000 | Cost of fuel sold | expense | |
| 5010 | Cost of shop goods sold | expense | |
| 5100 | Fuel stock gains and losses | expense | |
| 5110 | Fuel transit gains and losses | expense | |
| 5120 | Shop stock losses and adjustments | expense | |
| 6000–6190 | Wages, power, water, security, repairs, maintenance, transport, licences, rent, consumables, bank charges, other | expense | |
| 6200 | Fuel used by the business | expense | |
| 6900 | Staff shortages written off | expense | |

## What each event posts

Dr = debit, Cr = credit.

| event | when | posts |
|---|---|---|
| **A shift closes** | when it is *declared* (closed), not when approved | **Sales:** Cr 4000 fuel sales, Cr 4010 shop sales. **Settlements**, one line each, as the cash-up records them: Dr 1000 cash, Dr 1020 mobile money, Dr 1030 card, Dr 1100 credit (the customer), Dr 4090 discounts and agreed-price differences (a credit premium is a credit here), Dr 1110 shortage (the attendant), Cr 4100 overage. **Fuel out:** Cr 1200 at moving average cost, Dr 5000 for litres sold, Dr 6200 for own use. **To the dip:** the tank's ledger litres are brought to its closing dip, Dr or Cr 5100. **Shop goods sold:** Cr 1210, Dr 5010 at average cost |
| Delivery received | when received | Dr 1200 litres received × cost; Cr 2010 litres *loaded* × cost (what the supplier bills); the difference to 5110 transit |
| Supplier invoice | when recorded | Dr 2010, Cr 2000 (the supplier) |
| Supplier paid | when recorded | Dr 2000, Cr 1010 bank (or 1000 cash) |
| Banking | when recorded | Dr 1010, Cr 1000 |
| Customer pays | when recorded | Dr 1010 bank (or 1000 cash), Cr 1100 (the customer) |
| Expense | when recorded | Dr 6xxx by category; Cr 1000 if from the till, 1010 if from the bank, 2000 if on a supplier's credit |
| Other income | when recorded | Dr cash or bank, Cr 4020 |
| Shortage recovered | when recorded | Cr 1110 (the attendant); Dr 1000 cash, 2300 salary deduction, 6900 write-off, or 4100 offset by a later overage |
| Opening stock | when recorded | Dr 1200 or 1210, Cr 3000 |
| Shop purchase | when received | Dr 1210, Cr 2010 |
| Shop damage, expiry, count adjustment | when recorded | 1210 against 5120, at average cost |
| Transfer between sites | each leg | Dr 1200 at the receiving tank, Cr 1200 at the sending tank, at the transfer's cost; each site's leg against 2200, which nets to nil across the company |
| Depot bulk sale | when loaded | Dr 1100 (credit) or 1000; Cr 4000; cost of sales from its fuel movement |
| Water drawn, stock-take adjustment, correction | when recorded | 1200 against 5100, at average cost |
| A shift voided after closing | when voided | its journal reversed |

**Why a shift posts at close, not approval.** Closes happen in order, one
station at a time. Stock and cost must post in the order fuel actually moved.
Approval is the manager's review: it does not move money or fuel.

**Moving average cost** comes from the ledger itself: the value of a tank's
1200 lines divided by their litres. A delivery changes the average; a sale
takes fuel out at it. If the books show a tank empty or negative, the last
purchase cost stands in.

## The reconciliations

**Books → Reconciliations** shows each control account against the record it
summarises, as of any date. A difference is a fact to explain, never rounded
away.

| control | books | against | must |
|---|---|---|---|
| Trial balance | all lines | — | be nil |
| Receivables 1100 | the control account | every customer's account: credit sales on closed shifts, plus depot credit sales, less payments | agree |
| Staff shortages 1110 | the control account | shortages less recoveries | agree |
| Fuel stock 1200 | ledger litres per tank | the tank's last closing dip | agree to the litre |
| Shop stock 1210 | ledger units per site | stock on hand | agree |
| Cash on hand 1000 | per site | cash taken, less banked, less till expenses | agree |
| Transfers 2200 | across the company | — | be nil |
| Payables 2000 | per supplier | invoices less payments | agree |
| Received, not invoiced 2010 | per supplier | delivered (as loaded, at cost) less invoiced | agree |

**Books → Receivables** is the customer-by-customer reconciliation and aging:
each customer's account against the books, what they owe by age (0–30, 31–60,
61–90, over 90 days, payments taken against the oldest sales first), their
limit and their last payment. Credit sales on a shift still open are shown in
their own column: they are on the account now and reach the books when the
shift closes. That is a timing difference, not an error.

## Bank and mobile money against their statements

**Books → Bank & mobile money**, per money account (a bank account, or a MoMo
wallet tied to its payment channel).

1. **Import** the statement as CSV and map its columns (date and time,
   description, reference, a signed amount or money in/out, balance). A line
   already imported is skipped, so overlapping statements are safe.
2. **Match automatically.** Bank: one book line to one statement line of the
   same amount within 5 days. Mobile money: the merchant payments inside each
   shift's window against that shift's MoMo takings, then whatever is left by
   day.
3. **Match by hand** what is left: tick lines on both sides; the button works
   only when the two sides sum to the same shilling. A match can be undone.
4. **Post** what only the statement knew (a bank charge, interest, a standing
   order) to an account of your choice; it posts and matches in one step. A
   customer payment, a banking or a transfer is recorded on its own screen and
   then matched, never posted from here.

The account **reconciles** when no statement line is unmatched and no book item
is more than 5 days old without reaching the statement. Deposits still in
transit within 5 days are listed, not counted against it. The summary reads:
statement balance + in the books, not yet on it − paid out, not yet on it − on
it, not in the books = the books.

**Move money** records a MoMo withdrawal to the bank, or bank to bank: the
amount that arrived goes to the receiving account, the fee comes out of the
sending one and posts to 6100 Bank and mobile-money charges. Until a withdrawal
is recorded, mobile money stays in 1020.

## Closing a month

`POST /api/books/periods/{year}/{month}/close`, or **Close month** on the
Reconciliations tab, by an accountant or head office. It is refused while any
shift of that month is still open. Once a month is closed, nothing posts into
it; a correction is a journal in the next month. A closed month does not reopen
through the app.

## Closing a year

`POST /api/books/years/{year}/close`, or **Close year** on the Reconciliations
tab, by an accountant or head office. It is refused until every month of the
year that has postings, and December, is closed, and it closes once. It writes
one journal dated 31 December that empties every income and expense account
into 3100 Retained earnings, site by site. The year's profit and loss still
shows what the year made: it reads trading entries only and leaves the closing
journal out. The balance sheet after it shows the profit in 3100.

## Proven

* `db/test/scenarios.sql` checks: every closed shift is in the books; the books
  balance; every control agrees; the app cannot write or edit the books; a
  manual journal must balance and be posted by an authorised role; a reversal
  mirrors its journal and cannot be repeated; a month cannot be closed by a
  supervisor or with a shift open; a depot day short by 120 litres posts the loss
  to 5100 at average cost and leaves the tank's ledger litres equal to its dip.
* `tools/sim` (90 days, 180 shifts) fails if any control differs, any journal
  is unbalanced, or any closed shift is missing from the books. It also imports
  bank and wallet statements, plants a short-credited deposit and an unrecorded
  standing order, and fails unless exactly those stay open; and it closes the
  year inside a transaction it rolls back, checking that retained earnings equal
  the year's profit to the shilling.

## Not yet

* **Tax.** VAT and excise are not split out; EFRIS and URA filing stay outside
  FCMS.
* **Bank feeds.** Statements come in as CSV; there is no direct link to a bank
  or network.
