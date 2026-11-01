-- Data fix (sm2-v1.1): clamp spaced-repetition schedules that grew without bound on shared review
-- items (one item per quiz type is answered many times). Only rows above the caps are touched.
UPDATE "ReviewItem"
SET "intervalDays" = LEAST("intervalDays", 365),
    "ease" = LEAST("ease", 3.0),
    "dueAt" = LEAST("dueAt", "updatedAt" + INTERVAL '365 days')
WHERE "intervalDays" > 365 OR "ease" > 3.0 OR "dueAt" > "updatedAt" + INTERVAL '365 days';
