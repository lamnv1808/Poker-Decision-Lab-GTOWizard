-- Integrity checks on a restored Poker Decision Lab database. Every row prints "check|violations";
-- a non-zero count is a failure. Foreign keys/unique keys are already enforced by pg_restore.
SELECT 'decision_hand_same_owner', count(*) FROM "RealDecision" d JOIN "RealHand" h ON h.id = d."realHandId" WHERE h."userId" <> d."userId"
UNION ALL SELECT 'annotation_decision_same_owner', count(*) FROM "Annotation" a JOIN "RealDecision" d ON d.id = a."decisionId" WHERE a."userId" <> d."userId"
UNION ALL SELECT 'attempt_session_same_owner', count(*) FROM "DecisionAttempt" a JOIN "TrainingSession" s ON s.id = a."sessionId" WHERE s."userId" <> a."userId"
UNION ALL SELECT 'ratinghistory_attempt_same_owner', count(*) FROM "RatingHistory" r JOIN "DecisionAttempt" a ON a.id = r."attemptId" WHERE a."userId" <> r."userId"
UNION ALL SELECT 'leakobservation_attempt_same_owner', count(*) FROM "LeakObservation" o JOIN "DecisionAttempt" a ON a.id = o."attemptId" WHERE a."userId" <> o."userId"
UNION ALL SELECT 'simhand_session_same_owner', count(*) FROM "SimHand" h JOIN "TrainingSession" s ON s.id = h."sessionId" WHERE s."userId" <> h."userId"
UNION ALL SELECT 'run_session_same_owner', count(*) FROM "ScenarioRun" r JOIN "TrainingSession" s ON s.id = r."sessionId" WHERE s."userId" <> r."userId"
UNION ALL SELECT 'unfinished_migrations', count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL
UNION ALL SELECT 'users_present_missing', CASE WHEN (SELECT count(*) FROM "User") > 0 THEN 0 ELSE 1 END;
