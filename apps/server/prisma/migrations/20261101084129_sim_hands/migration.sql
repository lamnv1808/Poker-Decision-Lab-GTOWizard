-- CreateTable
CREATE TABLE "SimHand" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "seed" INTEGER NOT NULL,
    "config" JSONB NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "feedback" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'play',
    "parentId" TEXT,
    "branchAt" INTEGER,
    "sessionId" TEXT,
    "steps" JSONB NOT NULL DEFAULT '[]',
    "version" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "SimHand_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SimHand_userId_status_updatedAt_idx" ON "SimHand"("userId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "SimHand_parentId_idx" ON "SimHand"("parentId");

-- AddForeignKey
ALTER TABLE "SimHand" ADD CONSTRAINT "SimHand_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
