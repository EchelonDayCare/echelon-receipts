# Banking, reconciliation and financial reporting plan

Status: implementation authorized by the owner; working-tree review build,
not released or approved as the production book of record.
Reviewed against current source with Codex; material corrections incorporated.

## Review-build delivery and remaining acceptance

Owner decisions: cash basis under accountant-approved rules, September 1 fiscal
boundary, one initial cutover selected during setup, intended main book of
record. Missing opening/funding evidence must remain unresolved.

Implemented in the working tree:

- Integer-cent, two-leg journals with immutable history, source correction
  reversals, raw-SQL guards, closed-period controls and versioned schema setup.
- Explicit conversion preview and a mandatory authenticated local safety
  backup before activation. Installing the code does not activate accounting.
- Local CSV and consent-based Azure PDF/image statement review, retained source
  evidence, signed card controls, duplicate/overlap checks and atomic staging.
- Partial/grouped receipt matching, paid-expense matching, new counterpart
  postings, transfer/card settlement and existing-journal matching.
- Statement-created purchases/refunds also create operational expense records
  atomically. Bank/card settlement does not recognize the purchase twice.
  Evidence-based expense voids preserve originals and reverse journals; voids
  are excluded from operational purchase lists and summary counts.
- Ranked, line-specific matching suggestions and an atomic deposit-batch
  picker, including partial batch capacity and period-crossing clearance.
- Unmatch, reasoned reopen, retained-evidence withdrawal and posted import
  reversal. Posted batches retain original expense snapshots and journals;
  their operational rows become zero-valued, immutable reversal records.
- Manual income/adjustment entry, opening correction by reversal, policy
  revisions for CCFRI/ACCB/MCCB/other funding, and journal review gates.
- Policy-enforced remittance allocations with service periods, references,
  original policy revisions and evidence. Liability-based funding supports
  partial releases and linked repayments; over-release, backdated dependency
  changes and unmatching a remittance with active dependants are blocked.
- Monthly, September-based quarterly/yearly P&L, category totals, trial balance,
  posted bank movement, journal/audit drill-down, CSV and print controls.
- Ledger-backed Finance overview and AGM financial AI inputs after activation.
  Provisional ledger data blocks financial AI drafting. Existing receipt,
  subsidy, purchase and AGM reference tables remain operational, labeled as
  such; they are not the authoritative accounting totals.
- Final-report/close warnings for missing openings, funding approval,
  classifications, unmatched individual payments and continuous statement
  coverage. Equal and opposite unmatched payments cannot hide in net clearing.
- Period-specific evidence review for identifiable outstanding payments and
  deposits in transit, checked against exact remaining source amounts. This
  never creates a cash movement or clears an unexplained balancing difference.
- Immutable saved report versions, original-figure retrieval and visible
  supersession after postings/review changes; versioned CSV and print output.
- Activated card-import navigation uses shared statement reconciliation.
  Prior purchase-only imports remain matchable and explicitly reversible.
- Cleanup blocks destructive financial/roster cascades before backup or
  deletion after activation; nonfinancial cleanup still works.
- Portable encrypted backups are validated and re-encrypted with the current
  installation key. Same-key safety copies are checked before staging; wrong
  keys, inconsistent accounting and incomplete WAL-bearing raw copies are
  refused. Failed staging preserves the previous pending backup. Startup
  restores retain an original database/sidecars until the swap succeeds and
  recover interrupted swaps.

The implementation gaps identified in the earlier review build are addressed.
Production book-of-record acceptance remains separate from code completion:

- Suggestions always require explicit acceptance. Uncertain funding remains
  unresolved; policies and remittance/release evidence are not inferred.
  Operator evidence is a local reason/audit record, not multi-user approval
  identity or accountant certification.
- Confirm cutover treatment for cash receipts not stored by existing receipt
  workflows, unpaid items, card timing, assets, payroll, tax and all opening
  accounts with the accountant. Source dates are recognition dates; statement
  dates are settlement dates. Matching does not change source recognition.
- Still required: native Mac file/dialog/print acceptance and one
  owner/accountant-reviewed real period. Automated activated-accounting
  encrypted restore, cleanup and interrupted-swap cases have now passed.
  The supplied PDF has not been sent to Azure or used to activate live data.

Verification evidence for this review build: production frontend build;
full backend run with 368 passed and 2 ignored, followed by 26 finance and
3 restore tests after final safeguards; 107 frontend regression tests including
fail-closed financial cleanup; synthetic Edge interactions for bank deposit
batch allocation, funding release, versioned CSV and original report retrieval.
These synthetic checks do not replace the native or accountant acceptance.

## Review walkthrough

Use a disposable test copy, not the live book. Open Finance → Bank Statements,
select the initial September 1, preview conversion, and verify the assumptions
before Back up & enable. Record accounts/openings and leave unsupported policy
approvals unconfirmed. Import a synthetic CSV with independently verified
controls; allocate an existing receipt deposit and a card repayment; confirm
the deposit does not add revenue and the repayment does not add expense.
Check Accounting Reports and its provisional warnings, source drill-down,
reversal/reopen behavior and export. Unknown funding must remain unresolved.

## Goal

Reuse the credit-card statement import experience to add bank statements,
reconcile cash movements to business records, and produce consistent,
traceable financial reports without counting the same transaction twice.
Keep the user interface simple; do not confuse simplicity with incomplete
accounting underneath.

## Baseline reviewed before implementation

- `src/lib/expenses.ts:354-384`: revenue selection is parent-paid receipt
  amounts or operating receipt gross amounts. These are revenue scopes,
  not cash-versus-accrual accounting methods. Both group by receipt date.
- `src/screens/expenses/Reports.tsx:60-108`: monthly, quarterly and annual
  net results subtract recorded expenses from that receipt-derived revenue.
- `src/lib/db.ts:1288-1310`: existing deposit batches group receipts for
  physical bank deposits; they do not establish bank clearance.
- `src/screens/expenses/ImportStatement.tsx`: the current card importer
  provides upload, extraction, editable review, duplicate detection and
  atomic expense import. It does not maintain a bank or card ledger.
- Subsidy reports aggregate amounts attributed to receipts. This is not
  evidence that a government remittance was received or earned that month.

## Phase 0: settle accounting policy and opening position

Before ledger implementation, confirm with the owner/accountant:

- Authoritative reporting method: cash basis, accrual basis, or separately
  labeled views. Do not silently relabel the existing operating report as
  accrual accounting.
- Cutover date and scope: accounts, cards, currencies, fiscal year, opening
  bank/card balances, outstanding cheques, deposits in transit, unpaid
  amounts, prepayments and funding balances.
- Treatment of each funding program, restricted contributions, refundable
  deposits, grants, capital purchases, sales taxes and payroll liabilities.
- Whether the product is the financial book of record or a reconciled
  operational subledger exported to the accountant's accounting system.
- Recognition dates versus bank posting/value dates: retain each separately,
  including the service/funding period. Matching dates must not silently
  move income or expenses into a different reporting period.
- A policy matrix per funding program: evidence needed to recognize income,
  receivable/deferred/restricted treatment, release triggers, refunds and
  the person permitted to approve exceptions.

Keep these as explicit decisions, not guessed defaults. An initial supported
currency can be CAD; block unsupported currency rather than mixing totals.
Do not infer historical liabilities or receivables from incomplete records.

## Phase 1: one accounting source and safe migration

Introduce a small internal double-entry ledger with bank/card accounts,
receivables and clearing accounts, income/expense categories, liabilities,
assets and opening-balance accounts as required by the approved scope.
Users select ordinary categories; normal postings generate balanced
journals automatically. Advanced adjustments require explicit confirmation.

- Separate source documents, bank movements, accounting entries and
  reconciliation links. A statement line is evidence, not an automatic
  journal entry.
- Store new monetary amounts in integer minor units. Validate dates,
  currency, allocation totals and balanced journals with database-backed
  invariants.
  Existing receipt/expense/deposit amounts are REAL: specify deterministic
  decimal-to-minor-unit conversion, rounding and signed refund conventions.
  Preview conversion differences and reject invalid/out-of-range values.
  Do not hide discrepancies behind a broad reconciliation tolerance; new
  postings balance exactly in minor units, with explicit rounding entries
  only under approved policy.
- Adapt receipt creation/refunds/voids, expense creation/edits/deletions,
  recurring expenses, card imports and income entry through one posting
  mechanism. Use unique source references to make posting idempotent.
- Inventory all mutation paths, including direct SQL in the card importer,
  import-batch deletion, student force-delete, financial data cleanup,
  restore and recovery. Post the business record and its journal changes
  in the same database transaction. A UI helper alone is not enforcement:
  select and demonstrate a database/backend guard preventing application
  write paths from bypassing posting or changing immutable posted history.
  Preserve or archive referenced source records instead of deleting them.
- Define each adapter's posting matrix and lifecycle. Distinguish issuing a
  document, recognizing income, receiving payment and clearing the bank.
  Receipt amount/gross/pending fields do not, by themselves, prove earned
  income, a valid receivable or cleared cash. Corrections and outstanding
  balance settlement must have explicit accounting meanings.
- Preserve receipt numbering, saved receipt content and tax-receipt rules.
  Bank matching must not issue receipts or settle balances.
- Preserve original posted entries; changes use linked reversals and
  replacements. Block silent changes to closed/reconciled periods.
- Produce a dry-run migration comparison and pre-migration backup. Legacy
  rows with inadequate accounting detail remain visibly unresolved.
- Do not post both opening balances and historical transactions into the
  same cutover balance. Explicitly map opening outstanding items.
- Publish a per-source migration mapping for receipts/refunds, attributed
  subsidies, expenses, recurring expenses, card imports and deposit batches.
  Classify records as historical reference, opening outstanding detail or
  converted journal detail. Pause financial writes during the atomic,
  rerunnable migration; reconcile opening trial balance and legacy/new
  report comparisons before enabling posting. Deposit batches are grouping
  evidence, not an additional revenue or cash event.
- Back up, restore, export and validate the ledger and reconciliation data
  together. Preserve compatible legacy views until cutover is accepted.

## Phase 2: shared statement intake

Reuse file selection, extraction, transaction review and batch-status UI.
Preserve the existing card upload entry point while extending the underlying
statement model to support bank accounts and cards.

- Prefer deterministic CSV/PDF text extraction where supported; use Azure
  document extraction only when necessary and with clear disclosure.
- Preserve account identity, statement period, currency, source file hash,
  page/row provenance, original descriptions, debit/credit columns,
  opening/closing balances and any bank-provided transaction identifiers.
- Extract into a staging area. Require review before posting or matching.
- Retain every bank/card statement line, including payments, transfers and
  reversals that do not affect P&L. The current card importer excludes
  payments from expense creation; reuse that distinction, not its practice
  of omitting payment rows from imported expense batches. Validate card
  statements with a liability-aware balance equation.
- Validate line balances, printed totals, statement continuity and
  opening plus inflows minus outflows equals closing, where supplied.
- Retain statement order for same-day transactions. Support reverse-order
  listings and page breaks.
- Distinguish the account-activity period from a webpage's current balance.
  The September sample displays an October current balance; it must not
  become September's closing balance.
- Missing formal statement controls require an explicit reviewed exception;
  never invent an opening balance or claim independent verification from a
  balance merely inferred from the same rows.
- Deduplicate overlapping imports without collapsing legitimate identical
  payments. Use bank IDs when available, source hashes, row occurrence
  identity and candidate review; do not rely on the existing short
  date/amount/merchant hash alone.

## Phase 3: reconciliation and posting

Support one-to-one, one-to-many, many-to-one and partial allocations.
Suggest matches using account, amount, dates, references and remaining
unallocated amounts. Suggestions require user acceptance.

Actions: match existing records, record new income/expense, allocate a
transfer or card payment, split a transaction, identify a refund/reversal,
or leave unresolved. Unresolved money must not silently become revenue.

- Parent payments link to receipt/payment clearing; grouped deposits link
  to their component receipts without recognizing revenue a second time.
  A match creates no journal if the source event is already posted to the
  correct cash account. When an existing event is held in clearing or an
  outstanding account, acceptance may create the required cash/clearing
  entry, uniquely linked to that settlement, without new revenue/expense.
- Funding receipts settle approved funding receivables or follow the
  program's approved recognition policy. Overpayments and restricted or
  future-period money may remain liabilities.
- Credit-card purchases establish card liability; bank card repayments
  reduce it, rather than creating another expense.
  This does not determine the recognition date: cash-basis treatment of
  card purchases must follow the approved policy rather than assuming
  bank repayment date equals expense date.
- Internal transfers pair both sides, including timing differences, without
  creating income or expense.
- Loan principal is a liability movement; interest is separated. Capital
  purchases, payroll remittances, payroll expense and recoverable taxes use
  their approved account treatment.
- Cheque numbers alone do not identify payees or expense categories.
- Bank fees/rebates and refunds support linked corrective treatment.
- Allocation and posting complete atomically, with no over-allocation or
  race-condition duplicates. Failures leave the batch recoverable.
- Undo removes an unposted staging batch; posted/reconciled batches require
  auditable reversals or controlled reopening, never bulk hard deletion.
  Replace the existing card-import undo/delete workflow accordingly. An
  unmatch normally removes a reconciliation link, not the original business
  event; reverse only settlement/generated entries that are no longer valid.
  Review dependencies before reversing entries allocated elsewhere.

## Phase 4: statement close and controls

Show matched/unmatched amounts, book balance, statement balance, outstanding
cheques, deposits in transit and other approved reconciling items.

- Require a zero unexplained reconciliation difference before marking a
  statement reconciled. Equal deposit/withdrawal totals alone are not proof.
- Carry outstanding items forward and prevent overlapping statements from
  consuming the same allocation twice.
- Give each canonical statement line an explicit terminal reconciliation
  disposition: allocated, paired transfer or approved reconciling exception.
  Exception-only sign-off is qualified, not an unexplained balancing plug.
  Separate account reconciliation disposition from accounting classification:
  temporary suspense can explain cash but blocks final P&L/period close
  until resolved. Persist allocation capacity across duplicate statement
  representations and partial matches.
- Record closer, time, source evidence and opening/closing controls.
- Separate reconciliation completion from accounting period close. A
  balanced bank account can still contain unresolved P&L classification.
- Reopening requires a reason and invalidates affected reconciliation or
  report status visibly. Closed-period corrections follow approved policy.
  Track dependencies to later statement openings, transfer counterparts and
  period-close/report snapshots. Revalidate affected dependants without
  rewriting historical exported reports; mark old exports superseded.

## Phase 5: reports and navigation

Proposed module name: Finance, replacing Expenses while retaining old routes
and familiar actions. Sections: Overview, Income, Expenses, Bank Statements,
Credit Card Statements, Reconciliation and Reports.

Use shared ledger-backed report queries for:

- Income and expense/P&L by month, quarter, fiscal/calendar year and category.
- Cash movements and bank/card reconciliation.
- Funding earned/applied/received/outstanding, as supported by policy.
- Trial balance and accountant export; opening and closing account balances.
- Balance sheet only once opening assets/liabilities, accounting method and
  adjustments support an accurate statement. Never imply completeness from
  bank reconciliation alone.

Update financial overview, expense dashboard, monthly financial reports,
subsidy reconciliation, AGM financial summaries, print/PDF/CSV output and
Ask Echelon definitions. Student-specific reports retain their scope but
must agree on shared figures or explain the differences.

Parent-paid and operating views remain clearly labeled breakdowns, not
competing definitions of total profit. Display accounting method, period,
coverage, unresolved items and close status. Every total drills down to
entries and their source documents. Reconciled cash can be complete while
the financial report remains provisional due to missing classifications,
accruals or adjustments.

## Phase 6: evidence and acceptance

Use synthetic data for automated tests. The supplied bank PDF remains local;
do not check it, its extracted contents or identifying account data into Git.

Required cases:

- Existing receipt plus bank deposit counts once; deposit batches and partial
  receipts allocate correctly, including period-crossing settlements.
- Funding already represented in fees does not become duplicate revenue.
  Combined, restricted, future-period and overpaid funding follow policy.
- Card purchase plus bank repayment counts expense once; refunds work.
- Transfers, loans, assets, payroll and tax allocations follow approved rules.
- Overlapping/repeated imports do not duplicate entries; two genuinely
  identical transactions remain distinct.
- Missing rows, bad columns, malformed amounts, unbalanced journals,
  mismatched controls and over-allocation block the affected operation.
- Failed imports roll back completely; retry, undo, reversal, reopening and
  backup/restore preserve balances and audit history.
- Direct financial SQL, student force-delete, batch deletion, cleanup and
  recovery cannot bypass posting/period guards or orphan posted sources.
  Fault injection between source and journal writes leaves neither committed.
- Card payment/transfer lines remain available for reconciliation without
  entering P&L; unmatching never deletes the underlying receipt or expense.
- Legacy REAL conversion, negative refunds, fractional-cent edge cases and
  exact minor-unit balance checks have deterministic expected results.
- Cutover migration does not double-post balances; legacy comparisons
  explain every intentional reporting change.
- Screen, drill-down, print/export, dashboard and AGM figures agree for the
  same report scope and accounting method.

Local manual acceptance on the September sample must reproduce deposits
33,210.86, withdrawals 36,258.97 and net cash movement -3,048.11. This is
not an assertion of September profit. Compare classifications against
receipts, deposit batches, card records and funding remittance advice.
Have the owner/accountant accept one fully reconciled period before release.

## Delivery sequence

1. Approve accounting policy, cutover and product scope.
2. Build ledger, source adapters and migration with comparison evidence.
3. Extend statement intake and reconciliation review.
4. Wire reports and period controls end to end.
5. Complete local statement walkthrough and owner/accountant sign-off.
6. Release with backup, migration instructions and documented limitations.

No automatic bank connection, mobile app, tax filing, payroll engine or
autonomous AI posting is included. Existing local encrypted storage and
keychain patterns remain in place; Azure extraction endpoints must be
configured for the intended resource before cloud extraction is relied on.
