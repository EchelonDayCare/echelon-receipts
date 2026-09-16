-- Update only the untouched legacy default. Custom subsidy-statement email
-- templates must remain exactly as their owners configured them.
UPDATE settings
SET value = 'Hi,

Please find attached the monthly fee breakdown for {{student}} for {{month_label}} {{year}}.

This shows how CCFRI, Affordable Child Care Benefit (ACCB), and any Métis Child Care Benefit (MCCB) funding reduced the gross monthly fee to the amount paid by the parent. The statement records the parent-paid portion for this period.

If you have any questions, please reply to this email.

Thank you,
Echelon Daycare Society
{{contact_email}} | {{contact_phone}}'
WHERE key = 'subsidy_stmt_body'
  AND value = 'Hi,

Please find attached the monthly fee breakdown for {{student}} for {{month_label}} {{year}}.

This shows how the BC government subsidies (CCFRI and any Affordable Child Care Benefit) reduced your gross monthly fee to the amount you actually paid. The amount you paid is what appears on your Annual Tax Receipt for the CRA.

If you have any questions, please reply to this email.

Thank you,
Echelon Daycare Society
{{contact_email}} | {{contact_phone}}';
