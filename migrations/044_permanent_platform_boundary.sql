-- ABOUTME: Makes an excluded platform boundary permanent (spec Section 7.1, plan 002 decision 9).
-- ABOUTME: A channel that was shared with another organization never opens again.

CREATE TRIGGER channels_platform_boundary_permanent
BEFORE UPDATE OF platform_boundary ON channels
WHEN OLD.platform_boundary = 'excluded' AND NEW.platform_boundary IS NOT 'excluded'
BEGIN
  SELECT RAISE(ABORT, 'platform boundary is permanent');
END;
