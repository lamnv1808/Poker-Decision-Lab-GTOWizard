-- AlterTable
ALTER TABLE "DecisionAttempt" ADD COLUMN     "annotationId" TEXT,
ADD COLUMN     "familyId" TEXT,
ADD COLUMN     "reasoning" TEXT,
ADD COLUMN     "responseMs" INTEGER,
ADD COLUMN     "track" TEXT NOT NULL DEFAULT 'strategy';

-- CreateTable
CREATE TABLE "RealHand" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "handId" TEXT NOT NULL,
    "tournamentId" TEXT,
    "tournamentName" TEXT,
    "format" TEXT NOT NULL,
    "playedAt" TIMESTAMP(3),
    "raw" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "issues" JSONB NOT NULL,
    "notes" TEXT[],
    "split" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RealHand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RealDecision" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "realHandId" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "heroActionNo" INTEGER NOT NULL,
    "street" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "issues" JSONB NOT NULL,
    "split" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "stackDepthBB" DOUBLE PRECISION NOT NULL,
    "potBB" DOUBLE PRECISION NOT NULL,
    "toCallBB" DOUBLE PRECISION NOT NULL,
    "investedBB" DOUBLE PRECISION NOT NULL,
    "playersInPot" INTEGER NOT NULL,
    "multiway" BOOLEAN NOT NULL,
    "facingAllIn" BOOLEAN NOT NULL,
    "topics" TEXT[],
    "reviewTags" TEXT[],
    "observed" JSONB NOT NULL,
    "potOdds" JSONB,
    "playedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RealDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Annotation" (
    "id" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "source" TEXT NOT NULL,
    "authorKind" TEXT NOT NULL,
    "infoAvailable" JSONB NOT NULL,
    "assumedRanges" JSONB NOT NULL,
    "economics" JSONB NOT NULL,
    "missingInfo" TEXT[],
    "evaluated" JSONB NOT NULL,
    "recommendation" TEXT NOT NULL,
    "explanationVi" TEXT NOT NULL,
    "explanationEn" TEXT,
    "confidence" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "solverMeta" JSONB,
    "toleranceBB" DOUBLE PRECISION,
    "verifiedById" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "supersedesId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Annotation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RealHand_userId_split_idx" ON "RealHand"("userId", "split");

-- CreateIndex
CREATE UNIQUE INDEX "RealHand_userId_handId_key" ON "RealHand"("userId", "handId");

-- CreateIndex
CREATE INDEX "RealDecision_userId_status_street_idx" ON "RealDecision"("userId", "status", "street");

-- CreateIndex
CREATE INDEX "RealDecision_userId_split_idx" ON "RealDecision"("userId", "split");

-- CreateIndex
CREATE UNIQUE INDEX "RealDecision_userId_externalId_key" ON "RealDecision"("userId", "externalId");

-- CreateIndex
CREATE INDEX "Annotation_userId_status_idx" ON "Annotation"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Annotation_decisionId_version_key" ON "Annotation"("decisionId", "version");

-- AddForeignKey
ALTER TABLE "RealHand" ADD CONSTRAINT "RealHand_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RealDecision" ADD CONSTRAINT "RealDecision_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RealDecision" ADD CONSTRAINT "RealDecision_realHandId_fkey" FOREIGN KEY ("realHandId") REFERENCES "RealHand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Annotation" ADD CONSTRAINT "Annotation_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "RealDecision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Annotation" ADD CONSTRAINT "Annotation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
