-- AlterTable
ALTER TABLE "SimHand" ADD COLUMN     "bookmarked" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "exactKey" TEXT,
ADD COLUMN     "fingerprint" TEXT,
ADD COLUMN     "origin" JSONB;

-- AlterTable
ALTER TABLE "UserPreference" ADD COLUMN     "historyResetAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ScenarioHistory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "contentKey" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "firstPlayedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastPlayedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "timesPlayed" INTEGER NOT NULL DEFAULT 0,
    "timesCompleted" INTEGER NOT NULL DEFAULT 0,
    "correct" INTEGER NOT NULL DEFAULT 0,
    "incorrect" INTEGER NOT NULL DEFAULT 0,
    "lastResult" TEXT,
    "ratingEligible" BOOLEAN NOT NULL DEFAULT false,
    "lastConfidence" INTEGER,
    "firstRefId" TEXT,
    "lastRefId" TEXT,

    CONSTRAINT "ScenarioHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScenarioHistory_userId_module_lastPlayedAt_idx" ON "ScenarioHistory"("userId", "module", "lastPlayedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ScenarioHistory_userId_contentKey_key" ON "ScenarioHistory"("userId", "contentKey");

-- CreateIndex
CREATE INDEX "SimHand_userId_fingerprint_idx" ON "SimHand"("userId", "fingerprint");

-- CreateIndex
CREATE INDEX "SimHand_userId_exactKey_idx" ON "SimHand"("userId", "exactKey");

-- AddForeignKey
ALTER TABLE "ScenarioHistory" ADD CONSTRAINT "ScenarioHistory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every user's existing scenario runs become history (played / completed counts), so
-- "played" status is correct immediately after the upgrade. Original runs and attempts are untouched.
INSERT INTO "ScenarioHistory" ("id", "userId", "contentKey", "module", "firstPlayedAt", "lastPlayedAt", "timesPlayed", "timesCompleted", "ratingEligible", "firstRefId", "lastRefId")
SELECT gen_random_uuid()::text, r."userId", 'scenario:' || v."scenarioId", s."mode",
       min(r."startedAt"), max(r."startedAt"), count(*)::int,
       (count(*) FILTER (WHERE r."status" = 'completed'))::int, false,
       (array_agg(r."id" ORDER BY r."startedAt"))[1], (array_agg(r."id" ORDER BY r."startedAt" DESC))[1]
FROM "ScenarioRun" r
JOIN "ScenarioVersion" v ON v."id" = r."scenarioVersionId"
JOIN "Scenario" s ON s."id" = v."scenarioId"
GROUP BY r."userId", v."scenarioId", s."mode"
ON CONFLICT ("userId", "contentKey") DO NOTHING;
