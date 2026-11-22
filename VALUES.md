# FCMS -- are the numbers right?

80 of 80 checks pass.

| | Kind | Screen | Check | Detail |
|---|---|---|---|---|
| PASS | logic | Dashboard | total revenue = sum of the sites | 0 vs 0 |
| PASS | logic | Dashboard | total litres = sum of the sites | 0 vs 0 |
| PASS | logic | Dashboard | pumps active <= pumps | 0 of 3 |
| PASS | display | Dashboard | shows the total revenue | UGX 0 |
| PASS | logic | Tanks | tanks received | 4 |
| PASS | truth | Tanks | D1-PMS: litres are the database's (last dip, else book) | 42000 vs 42000 |
| PASS | logic | Tanks | D1-PMS: fill % = litres / capacity | 35% |
| PASS | display | Tanks | D1-PMS shows its litres | 42.0k / 120k L |
| PASS | truth | Tanks | D2-AGO: litres are the database's (last dip, else book) | 72000 vs 72000 |
| PASS | logic | Tanks | D2-AGO: fill % = litres / capacity | 48% |
| PASS | display | Tanks | D2-AGO shows its litres | 72.0k / 150k L |
| PASS | truth | Tanks | T1-PMS: litres are the database's (last dip, else book) | 2428.3 vs 2428.3 |
| PASS | logic | Tanks | T1-PMS: fill % = litres / capacity | 12.1% |
| PASS | display | Tanks | T1-PMS shows its litres | 2.4k / 20k L |
| PASS | truth | Tanks | T2-AGO: litres are the database's (last dip, else book) | 12560.1 vs 12560.1 |
| PASS | logic | Tanks | T2-AGO: fill % = litres / capacity | 41.9% |
| PASS | display | Tanks | T2-AGO shows its litres | 12.6k / 30k L |
| PASS | logic | Credit customers | customers received | 5 |
| PASS | truth | Credit customers | WHL-01: balance is the database's | 112640000 vs 112640000 |
| PASS | logic | Credit customers | WHL-01: headroom = limit - balance | -22640000 |
| PASS | display | Credit customers | WHL-01 shows its balance | UGX 112,640,000 |
| PASS | truth | Credit customers | KIB-01: balance is the database's | -20 vs -20 |
| PASS | logic | Credit customers | KIB-01: headroom = limit - balance | 2000020 |
| PASS | display | Credit customers | KIB-01 shows its balance | UGX 20 paid ahead |
| PASS | truth | Credit customers | KIB-02: balance is the database's | 2443749.1 vs 2443749.1 |
| PASS | logic | Credit customers | KIB-02: headroom = limit - balance | 2556250.9 |
| PASS | display | Credit customers | KIB-02 shows its balance | UGX 2,443,749.10 |
| PASS | truth | Credit customers | WHL-02: balance is the database's | 49910000 vs 49910000 |
| PASS | logic | Credit customers | WHL-02: headroom = limit - balance | -9910000 |
| PASS | display | Credit customers | WHL-02 shows its balance | UGX 49,910,000 |
| PASS | truth | Credit customers | WHL-03: balance is the database's | 0 vs 0 |
| PASS | logic | Credit customers | WHL-03: headroom = limit - balance | 25000000 |
| PASS | display | Credit customers | WHL-03 shows its balance | UGX 0 |
| PASS | truth | Shift reports | head office sees every station's and depot's shifts | 24 on screen, 24 in the database |
| PASS | logic | Shift reports | rows to check | 24 |
| PASS | logic | Shift reports | every shift: fuel + shop = cash + electronic + credit + agreed + discounts + shortage - overage |  |
| PASS | truth | Shift reports | fuel sales = what the attendants were charged | 24 shifts |
| PASS | truth | Shift reports | shop sales = what the sellers were charged | 24 shifts |
| PASS | truth | Shift reports | cash = the cash and drops handed in | 24 shifts |
| PASS | truth | Shift reports | shortage = the shortages raised against attendants | 24 shifts |
| PASS | truth | Shift reports | litres = the litres sold through the meters | 24 shifts |
| PASS | display | Shift reports | every row names its site | 0 without |
| PASS | display | Shift reports | total sales card = fuel + shop of the listed shifts | UGX 151,511,720.00 |
| PASS | display | Shift reports | Sales & Payments: every row shows it balances | 24 of 24 rows balance on screen |
| PASS | display | Shift reports | no made-up fuel price on the gain/loss value |  |
| PASS | logic | Shift detail | cash-ups to check | 46 |
| PASS | logic | Shift detail | litres sold = metered - tests - own use - returned to tank |  |
| PASS | logic | Shift detail | cash expected = fuel + shop - mobile money - card - credit - agreed prices - discounts - drops |  |
| PASS | logic | Shift detail | cash expected - cash counted = shortage - overage |  |
| PASS | logic | Shift detail | an attendant short or over is never shown as balanced |  |
| PASS | truth | Shift detail | each shortage is the one raised against that attendant |  |
| PASS | truth | Site operations | each shift's fuel sales = what its attendants were charged | 2 shifts on 2026-11-20, 0 off |
| PASS | display | Overview | says how many sites there are | 2 |
| PASS | display | Overview | no made-up date or trend |  |
| PASS | logic | Management pack | revenue = every site's pump and depot sales + shop sales | 257082030 vs 255837030 + 1245000 |
| PASS | display | Losses | says loss or gain the database's way round | -114.97 L: "Fuel the books expect that the dips did not find" |
| PASS | truth | Losses | the period's total is every site's | -114.97000000000003 vs -114.97 |
| PASS | truth | Products | pump price = the last price executed |  |
| PASS | logic | Products | every fuel in stock has a cost | AGO 4829.56, PMS 5119.28 |
| PASS | display | Pump setup | no nozzle says "No tank linked" |  |
| PASS | display | Tank inventory | counts the sites it shows | 2 |
| PASS | logic | Books | controls received | 18 |
| PASS | logic | Books | control Bank (1010) Stanbic Kiboga collections: 2 statement line(s) not in the books, 1 book item(s) not on the statement | planted in the demo: off by 230000 |
| PASS | display | Books | no Trial balance tab |  |
| PASS | display | Books | no Balance sheet tab |  |
| PASS | logic | Books | every journal: debits = credits (database) | 0 unbalanced |
| PASS | logic | Books | /api/books/trial-balance is gone | 404 |
| PASS | logic | Books | /api/books/balance-sheet is gone | 404 |
| PASS | logic | Books | /api/books/years/2025/close is gone | 404 |
| PASS | logic | Profit & loss | total income = sum of income lines |  |
| PASS | logic | Profit & loss | net profit = gross profit - expenses | 22408321.76 |
| PASS | logic | Profit & loss | gross profit = income - cost of sales | 25343321.76 |
| PASS | truth | Bank & mobile money | Stanbic Kiboga collections: balance is the database's | 331890310.1 vs 331890310.1 |
| PASS | truth | Bank & mobile money | Airtel merchant wallet: balance is the database's | 2535500 vs 2535500 |
| PASS | truth | Bank & mobile money | MTN merchant wallet: balance is the database's | 5709200 vs 5709200 |
| PASS | display | Suppliers | an auditor is offered no invoice or payment form |  |
| PASS | display | Users | an auditor is offered no Create User |  |
| PASS | display | Expenses | an auditor is offered no Add Expense |  |
| PASS | display | Reports | a station accountant's daily statement has the month's days |  |
| PASS | display | Credit customers | a station accountant sees only the station's debtors | DEMU Traders Ltd |