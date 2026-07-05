# Reports & Compliance — Roadmap

The Reports & Compliance module ships with everything the app can produce from data it already collects.
This document lists reports we can add if we start collecting the extra data.

## Ships in v0.5.0

| Report | Purpose | Regulation reference |
|---|---|---|
| **Monthly Revenue** | Receipts issued + collected per month, quarterly totals | Bookkeeping |
| **Aging (A/R)** | Outstanding balances by student | Bookkeeping |
| **Subsidy Reconciliation** | CCFRI + ACCB claimed by month | BC Ministry CCFRI/ACCB program |
| **Enrollment Roster** | Printable roster of active students | BC CCLR §57 (records on-site) |
| **Attendance Summary** | Days present, absences, hours per child per month | BC CCLR §57 (daily records) |
| **Staff Credentials Compliance** | ECE / CRC / First Aid / TB expiry tracking | BC CCLR ss.15–19, Schedule A |
| **Emergency Drill Log** | Fire / earthquake / lockdown drill history + monthly-fire-drill gap alert | BC CCLR §56 |
| **AGM / Board Package** | Multi-year enrollment + revenue rollup | BC Societies Act — AGM requirements |

## Blocked on new data collection

These are useful but need fields the app doesn't have today. Ask and I'll add the data-entry UI + reports together.

### High priority (small addition)

1. **Age-group ratio compliance**
   - Needs: `date_of_birth` field on students table.
   - Enables: automatic age-group classification (Infant/Toddler / 3-5 / OSC), daily staff:child ratio check against BC CCLR §14, kindergarten-transition planning.
   - Ratios required by BC CCLR:
     - Under 36 months (Infant/Toddler): 1 staff : 4 children (min 1 ECE + 1 ECEA per group of 12)
     - 30 months–5 years (Group): 1 : 8 (1 ECE per group of 25)
     - School Age: 1 : 15

2. **Emergency contacts / pickup authorization**
   - Needs: additional fields on students table: `emergency_contact_name`, `emergency_contact_phone`, `emergency_contact_relation`, `pickup_authorized_persons` (multi-line text).
   - Enables: Emergency Contact Report (printed daily, kept with attendance log), pickup verification screen for staff.
   - Regulation: BC CCLR §57(2)(g) requires emergency contact on file.

3. **Program-type per child**
   - Needs: `program` field on students (Infant/Toddler | Group | School Age | Multi-Age).
   - Enables: CCOF monthly enrollment report (submitted to BC Ministry monthly for operating grants); more accurate subsidy split by program.

4. **Home address / phone**
   - Needs: `home_address`, `phone` on students.
   - Enables: Complete enrollment record required for licensing inspection.

### Medium priority (new table)

5. **Immunization Records**
   - Needs new `immunizations` table: `student_id`, `vaccine_name`, `date_given`, `next_due`, `exemption_reason`.
   - Enables: Immunization status report (public health outbreak follow-up), overdue-vaccine reminders.
   - Note: BC does not currently mandate childcare immunizations, but Vancouver Coastal Health strongly recommends record-keeping.

6. **Injury / Incident Log**
   - Needs new `incidents` table: `student_id`, `incident_date`, `incident_time`, `location`, `injury_body_part`, `description`, `action_taken`, `staff_notified`, `parent_notified_time`, `parent_signature_captured`.
   - Enables: Incident Report (required to be filed within 24h for reportable incidents per BC CCLR §55), summary counts for annual licensing review.
   - Reportable incidents (§55(2)): death, serious injury/illness requiring medical attention, unexpected removal from care, missing child, abuse allegation, fire/emergency evacuation.

7. **Medication Administration Log**
   - Needs new `medications` table + `medication_admins` table.
   - Enables: Daily medication log required whenever staff administer any medicine (prescription or OTC), with parent authorization tracking.
   - Regulation: BC CCLR §46 (Medication Administration).

### Lower priority

8. **Field Trip Log**
   - Needs: `field_trips` table with attendance list, permission-slip status, travel plan.
   - Regulation: BC CCLR §54 (Off-Premises Activity).

9. **Sleep / Rest Log (Infant care only)**
   - Needs: `sleep_check` table per infant per day.
   - Regulation: Best practice — Infant sleep-position checks every 15 min.

10. **T3010 Registered Charity Return support**
    - Needs: full income + expense ledger inside the app (would replace QuickBooks).
    - Recommendation: keep bookkeeping in QuickBooks; export from there. Building a mini-ledger in this app duplicates existing tools.

11. **CCOF Monthly Report auto-generator**
    - Needs: program-type per child (#3) + monthly enrollment snapshot table.
    - Enables: pre-filled CCOF form for submission to BC Ministry.

## Summary

**Live now:** 8 reports covering financial and BC CCLR §56–§57 basics.
**Small data addition unlocks:** age-ratio checker, emergency contacts, CCOF prep.
**New tables unlock:** immunizations, incidents, medications, field trips.
**Not recommended in-app:** T3010 support (use QuickBooks + accountant).
