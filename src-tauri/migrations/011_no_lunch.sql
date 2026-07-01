-- Add lunch-deduction awareness to staff_hours.
-- Rule: 30-min unpaid lunch is deducted automatically UNLESS no_lunch=1
-- (staff checked the "No Ln" box on the sign-in sheet meaning they
-- worked through lunch and should be paid for the full shift).
ALTER TABLE staff_hours ADD COLUMN no_lunch INTEGER NOT NULL DEFAULT 0;
