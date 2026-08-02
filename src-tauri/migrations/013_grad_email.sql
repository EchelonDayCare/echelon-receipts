-- v3.8.0: default subject/body for graduation reel emails to parents.
-- Uses the same {{student}} {{year}} {{contact_email}} {{contact_phone}}
-- placeholder syntax as receipt emails (see 003_email.sql, 004_annual_receipts.sql).
INSERT OR IGNORE INTO settings (key, value) VALUES
    ('grad_reel_email_subject', 'A little graduation memory from Echelon — {{student}} ({{year}})'),
    ('grad_reel_email_body',    'Hi {{parent_name}},

Congratulations to {{student}} on graduating from Echelon Daycare! We put together a short video reel with some of our favourite photos of {{student}} from this year — it is attached to this email.

We loved having {{student}} with us. Thank you for trusting us with such a special part of the year.

Warmly,
Echelon Daycare
{{contact_email}} | {{contact_phone}}');
