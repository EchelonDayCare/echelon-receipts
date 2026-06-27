-- Audit columns on receipts
ALTER TABLE receipts ADD COLUMN emailed_at TEXT;
ALTER TABLE receipts ADD COLUMN emailed_to TEXT;

-- Email settings (all non-secret; SMTP password lives in OS Keychain)
INSERT OR IGNORE INTO settings (key, value) VALUES
    ('sender_email',  ''),
    ('sender_name',   'Echelon Daycare Society'),
    ('smtp_host',     'smtp-mail.outlook.com'),
    ('smtp_port',     '587'),
    ('smtp_user',     ''),
    ('bcc_self',      '1'),
    ('email_subject', 'Receipt #{{receipt_no}} - {{student}} - {{description}}'),
    ('email_body',    'Hi,

Please find attached the receipt for {{student}} ({{description}}).

Amount: ${{amount}}{{pending_line}}

Thank you,
Echelon Daycare Society
{{contact_email}} | {{contact_phone}}');
