-- 004_corrections.sql
--
-- Two more things that could be created but never corrected.
--
-- 1. Farmer and supplier details. A wrong phone number or a wrong mobile-money
--    name is exactly what makes a payout bounce — and the app already warns
--    about name mismatches while giving nobody a way to fix one. These are
--    reference data, not money, so they are simply editable. Every change is
--    written to audit_log, which is where the history belongs.
--
-- 2. Grading. A moisture reading typed as 9.50 instead of 14.50 produced a
--    wrong settlement with no way back. A delivery may now be re-graded — but
--    only while its settlement is still a draft. Once money has been approved
--    the answer is a reversal, not a quiet edit, and the trigger below makes
--    that the database's opinion rather than a convention.

-- Who last changed a farmer's payout details, and when. The detail lives in
-- audit_log; these columns just make it visible on the screen.
ALTER TABLE farmer   ADD COLUMN updated_at TEXT;
ALTER TABLE supplier ADD COLUMN updated_at TEXT;

-- A graded delivery may be re-graded only while nothing has been approved.
CREATE TRIGGER quality_test_no_regrade_after_approval BEFORE UPDATE ON quality_test
WHEN EXISTS (SELECT 1 FROM settlement s
              WHERE s.delivery_id = OLD.delivery_id
                AND s.status IN ('Approved', 'Paid'))
BEGIN
  SELECT RAISE(ABORT,
    'this delivery has an approved settlement: reverse the payment, do not re-grade');
END;

-- The grade must always be one the rules produce, whether it arrived by insert
-- or by re-grade.
CREATE TRIGGER quality_test_grade_stays_valid BEFORE UPDATE ON quality_test
WHEN NEW.grade NOT IN ('A', 'B', 'C', 'REJECT')
BEGIN SELECT RAISE(ABORT, 'grade must be A, B, C or REJECT'); END;
