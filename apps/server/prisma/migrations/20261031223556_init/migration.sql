-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserPreference" (
    "userId" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "defaultMode" TEXT NOT NULL DEFAULT 'practice',
    "explanationView" TEXT NOT NULL DEFAULT 'quick',
    "strategyView" TEXT NOT NULL DEFAULT 'gto',
    "showBB" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserPreference_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "SkillCategory" (
    "key" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameVi" TEXT NOT NULL,

    CONSTRAINT "SkillCategory_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "SourceMetadata" (
    "id" TEXT NOT NULL,
    "classification" TEXT NOT NULL,
    "methodEn" TEXT NOT NULL,
    "methodVi" TEXT NOT NULL,
    "reference" TEXT,
    "reviewedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SourceMetadata_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Scenario" (
    "id" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "currentVersion" INTEGER NOT NULL,
    "published" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Scenario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScenarioVersion" (
    "id" TEXT NOT NULL,
    "scenarioId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "definition" JSONB NOT NULL,
    "sourceId" TEXT NOT NULL,
    "difficulty" INTEGER NOT NULL,
    "skills" TEXT[],
    "concepts" TEXT[],
    "validationReport" JSONB NOT NULL,
    "validatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScenarioVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DecisionNode" (
    "id" TEXT NOT NULL,
    "scenarioVersionId" TEXT NOT NULL,
    "nodeKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "skills" TEXT[],
    "concepts" TEXT[],
    "leakOpportunities" TEXT[],
    "hasModel" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "DecisionNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StrategyOption" (
    "id" TEXT NOT NULL,
    "decisionNodeId" TEXT NOT NULL,
    "optionKey" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "sizingMinBB" DOUBLE PRECISION,
    "sizingMaxBB" DOUBLE PRECISION,
    "sizingMinPot" DOUBLE PRECISION,
    "sizingMaxPot" DOUBLE PRECISION,
    "modelKey" TEXT,
    "rubricGrade" TEXT,
    "solverFrequency" DOUBLE PRECISION,
    "solverEv" DOUBLE PRECISION,
    "correct" BOOLEAN,

    CONSTRAINT "StrategyOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrainingSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "TrainingSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScenarioRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT,
    "scenarioVersionId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "steps" JSONB NOT NULL DEFAULT '[]',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ScenarioRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DecisionAttempt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clientAttemptId" TEXT NOT NULL,
    "sessionId" TEXT,
    "runId" TEXT,
    "scenarioVersionId" TEXT,
    "decisionNodeId" TEXT,
    "attemptType" TEXT NOT NULL,
    "itemRef" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "action" JSONB NOT NULL,
    "optionKey" TEXT,
    "graded" BOOLEAN NOT NULL,
    "grade" TEXT,
    "gradeBasis" TEXT NOT NULL,
    "evLoss" DOUBLE PRECISION,
    "evUnit" TEXT,
    "score" DOUBLE PRECISION,
    "ratingEligible" BOOLEAN NOT NULL,
    "ratingApplied" BOOLEAN NOT NULL DEFAULT false,
    "ratingWeight" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "isError" BOOLEAN NOT NULL,
    "confidence" INTEGER,
    "gradingMethodVersion" TEXT NOT NULL,
    "street" TEXT,
    "heroPosition" TEXT,
    "effectiveStackBB" DOUBLE PRECISION,
    "difficulty" INTEGER NOT NULL,
    "skills" TEXT[],
    "concepts" TEXT[],
    "leakKeys" TEXT[],
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DecisionAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Rating" (
    "userId" TEXT NOT NULL,
    "skill" TEXT NOT NULL,
    "rating" DOUBLE PRECISION NOT NULL,
    "rd" DOUBLE PRECISION NOT NULL,
    "vol" DOUBLE PRECISION NOT NULL,
    "games" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Rating_pkey" PRIMARY KEY ("userId","skill")
);

-- CreateTable
CREATE TABLE "RatingHistory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "skill" TEXT NOT NULL,
    "ratingBefore" DOUBLE PRECISION NOT NULL,
    "rdBefore" DOUBLE PRECISION NOT NULL,
    "volBefore" DOUBLE PRECISION NOT NULL,
    "ratingAfter" DOUBLE PRECISION NOT NULL,
    "rdAfter" DOUBLE PRECISION NOT NULL,
    "volAfter" DOUBLE PRECISION NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "opponentRating" DOUBLE PRECISION NOT NULL,
    "methodVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RatingHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeakObservation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "leakKey" TEXT NOT NULL,
    "isError" BOOLEAN NOT NULL,
    "evLossBB" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeakObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewItem" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "itemType" TEXT NOT NULL,
    "itemRef" TEXT NOT NULL,
    "repetitions" INTEGER NOT NULL DEFAULT 0,
    "ease" DOUBLE PRECISION NOT NULL DEFAULT 2.5,
    "intervalDays" INTEGER NOT NULL DEFAULT 0,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "lastQuality" INTEGER NOT NULL DEFAULT 0,
    "lapses" INTEGER NOT NULL DEFAULT 0,
    "mastery" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "lastGrade" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bookmark" (
    "userId" TEXT NOT NULL,
    "scenarioId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Bookmark_pkey" PRIMARY KEY ("userId","scenarioId")
);

-- CreateTable
CREATE TABLE "UserNote" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetRef" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportedFile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "format" TEXT,
    "status" TEXT NOT NULL,
    "handsParsed" INTEGER NOT NULL DEFAULT 0,
    "handsDuplicate" INTEGER NOT NULL DEFAULT 0,
    "handsFailed" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportedFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tournament" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "site" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tournament_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HandHistory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "importedFileId" TEXT NOT NULL,
    "tournamentId" TEXT,
    "site" TEXT NOT NULL,
    "externalHandId" TEXT NOT NULL,
    "playedAt" TIMESTAMP(3),
    "heroName" TEXT,
    "heroPosition" TEXT,
    "tableSize" INTEGER NOT NULL,
    "bigBlind" INTEGER NOT NULL,
    "allIn" BOOLEAN NOT NULL,
    "potComputed" INTEGER NOT NULL,
    "raw" TEXT NOT NULL,
    "parsed" JSONB NOT NULL,
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HandHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HandAction" (
    "id" TEXT NOT NULL,
    "handId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "street" TEXT NOT NULL,
    "player" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "allIn" BOOLEAN NOT NULL,
    "isHero" BOOLEAN NOT NULL,

    CONSTRAINT "HandAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportError" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "importedFileId" TEXT NOT NULL,
    "externalHandId" TEXT,
    "message" TEXT NOT NULL,
    "lineNo" INTEGER,
    "raw" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportError_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ScenarioVersion_scenarioId_version_key" ON "ScenarioVersion"("scenarioId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "DecisionNode_scenarioVersionId_nodeKey_key" ON "DecisionNode"("scenarioVersionId", "nodeKey");

-- CreateIndex
CREATE UNIQUE INDEX "StrategyOption_decisionNodeId_optionKey_key" ON "StrategyOption"("decisionNodeId", "optionKey");

-- CreateIndex
CREATE INDEX "TrainingSession_userId_startedAt_idx" ON "TrainingSession"("userId", "startedAt");

-- CreateIndex
CREATE INDEX "ScenarioRun_userId_startedAt_idx" ON "ScenarioRun"("userId", "startedAt");

-- CreateIndex
CREATE INDEX "DecisionAttempt_userId_createdAt_idx" ON "DecisionAttempt"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "DecisionAttempt_userId_itemRef_idx" ON "DecisionAttempt"("userId", "itemRef");

-- CreateIndex
CREATE UNIQUE INDEX "DecisionAttempt_userId_clientAttemptId_key" ON "DecisionAttempt"("userId", "clientAttemptId");

-- CreateIndex
CREATE INDEX "RatingHistory_userId_skill_createdAt_idx" ON "RatingHistory"("userId", "skill", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RatingHistory_attemptId_skill_key" ON "RatingHistory"("attemptId", "skill");

-- CreateIndex
CREATE INDEX "LeakObservation_userId_leakKey_idx" ON "LeakObservation"("userId", "leakKey");

-- CreateIndex
CREATE INDEX "ReviewItem_userId_dueAt_idx" ON "ReviewItem"("userId", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewItem_userId_itemType_itemRef_key" ON "ReviewItem"("userId", "itemType", "itemRef");

-- CreateIndex
CREATE INDEX "UserNote_userId_targetType_targetRef_idx" ON "UserNote"("userId", "targetType", "targetRef");

-- CreateIndex
CREATE INDEX "ImportedFile_userId_createdAt_idx" ON "ImportedFile"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Tournament_userId_site_externalId_key" ON "Tournament"("userId", "site", "externalId");

-- CreateIndex
CREATE INDEX "HandHistory_userId_playedAt_idx" ON "HandHistory"("userId", "playedAt");

-- CreateIndex
CREATE UNIQUE INDEX "HandHistory_userId_site_externalHandId_key" ON "HandHistory"("userId", "site", "externalHandId");

-- CreateIndex
CREATE UNIQUE INDEX "HandAction_handId_seq_key" ON "HandAction"("handId", "seq");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPreference" ADD CONSTRAINT "UserPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScenarioVersion" ADD CONSTRAINT "ScenarioVersion_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "Scenario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScenarioVersion" ADD CONSTRAINT "ScenarioVersion_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "SourceMetadata"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DecisionNode" ADD CONSTRAINT "DecisionNode_scenarioVersionId_fkey" FOREIGN KEY ("scenarioVersionId") REFERENCES "ScenarioVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StrategyOption" ADD CONSTRAINT "StrategyOption_decisionNodeId_fkey" FOREIGN KEY ("decisionNodeId") REFERENCES "DecisionNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingSession" ADD CONSTRAINT "TrainingSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScenarioRun" ADD CONSTRAINT "ScenarioRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScenarioRun" ADD CONSTRAINT "ScenarioRun_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "TrainingSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScenarioRun" ADD CONSTRAINT "ScenarioRun_scenarioVersionId_fkey" FOREIGN KEY ("scenarioVersionId") REFERENCES "ScenarioVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DecisionAttempt" ADD CONSTRAINT "DecisionAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DecisionAttempt" ADD CONSTRAINT "DecisionAttempt_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "TrainingSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DecisionAttempt" ADD CONSTRAINT "DecisionAttempt_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ScenarioRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DecisionAttempt" ADD CONSTRAINT "DecisionAttempt_scenarioVersionId_fkey" FOREIGN KEY ("scenarioVersionId") REFERENCES "ScenarioVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DecisionAttempt" ADD CONSTRAINT "DecisionAttempt_decisionNodeId_fkey" FOREIGN KEY ("decisionNodeId") REFERENCES "DecisionNode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rating" ADD CONSTRAINT "Rating_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RatingHistory" ADD CONSTRAINT "RatingHistory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RatingHistory" ADD CONSTRAINT "RatingHistory_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "DecisionAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeakObservation" ADD CONSTRAINT "LeakObservation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeakObservation" ADD CONSTRAINT "LeakObservation_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "DecisionAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewItem" ADD CONSTRAINT "ReviewItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bookmark" ADD CONSTRAINT "Bookmark_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bookmark" ADD CONSTRAINT "Bookmark_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "Scenario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserNote" ADD CONSTRAINT "UserNote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportedFile" ADD CONSTRAINT "ImportedFile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tournament" ADD CONSTRAINT "Tournament_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HandHistory" ADD CONSTRAINT "HandHistory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HandHistory" ADD CONSTRAINT "HandHistory_importedFileId_fkey" FOREIGN KEY ("importedFileId") REFERENCES "ImportedFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HandHistory" ADD CONSTRAINT "HandHistory_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HandAction" ADD CONSTRAINT "HandAction_handId_fkey" FOREIGN KEY ("handId") REFERENCES "HandHistory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportError" ADD CONSTRAINT "ImportError_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportError" ADD CONSTRAINT "ImportError_importedFileId_fkey" FOREIGN KEY ("importedFileId") REFERENCES "ImportedFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
