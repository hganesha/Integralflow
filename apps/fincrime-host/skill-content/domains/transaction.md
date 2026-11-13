### Transaction records and observation windows

Define feed coverage, subject/account scope, event identity, event status and the exact observation window before aggregation or anomaly analysis. Missing or truncated feeds cannot support a negative detection conclusion.

Use exact decimal amounts with explicit currency and units. Separate event reversals/cancellations, duplicates, pending and settled records. Do not sum currencies without an approved versioned conversion basis.

Expected activity is a sourced baseline with its own valid period; observed totals are not interchangeable with declared forecasts. Product/channel and temporal completeness determine the interpretation of a deviation.

Test duplicate/conflicting events, reversals, boundary timestamps, timezone differences, partial windows, late corrections and multiple currencies. Retain selected transaction IDs, totals and dataset scope so a reviewer can reproduce every finding.
