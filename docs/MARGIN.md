# What "margin" means here

Three screens show a bottom line -- the trading day, the period statement, and
depot-versus-station. They must subtract the same things or the numbers cannot
be quoted in a meeting. `tools/check_arithmetic.py` enforces that.

## The rules

**Revenue is gross.** Litres times the shift price, because that is what the
meter dispensed at. Every deduction happens once, at the bottom, never at
source -- mixing the two double-counts on whichever query nets early.

**Cost is weighted average.** What the tank actually holds, not what the last
delivery cost. For a depot load the cost is captured at the moment of sale and
never recomputed, so a later delivery cannot rewrite what an old load was worth.

**Then subtract, in this order:**

| Deduction | Why |
|---|---|
| Discounts given | Fuel left the pump at the shift price, so revenue counts the full amount. A discount is money the station agreed not to receive. |
| Own use, at cost | The generator, the pickup, the grounds tank. Reduces stock legitimately so it is not a loss -- but it was bought and never sold. |
| Stock loss, at cost | Fuel paid for and never sold. A cost of the period whether or not a cheque was written. |
| Expenses | Wages, power, security, repairs. |
| Shortages not recovered | Only the gap. Reporting the raised figure alone punishes a station that chases its money. |

Transfers appear nowhere. Moving fuel from the depot to the station at cost is
not a sale, and counting it would put the same fuel through the books twice.

## Two errors this document exists because of

Both compiled, typechecked, and passed every structural check.

**Discounts were never subtracted.** Revenue counted the full pump price and
nothing took the discount off, so margin was overstated by every shilling given
away -- and the statement told the reader, in words, that it was already
accounted for. It was not.

**Own-use fuel was charged nowhere.** A station running a generator through a
power cut burned diesel it had paid for, and no screen in the system ever saw
the cost.

Both flattered the numbers. That is the direction this class of error tends to
run, which is why it survives a long time.
