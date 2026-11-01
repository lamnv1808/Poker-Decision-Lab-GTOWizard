-- CreateTable
CREATE TABLE "LeakMemory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "leakKey" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "street" TEXT,
    "decisionType" TEXT,
    "label" JSONB NOT NULL,
    "drill" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "firstDetectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastDetectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "timesDetected" INTEGER NOT NULL DEFAULT 1,
    "severity" DOUBLE PRECISION NOT NULL,
    "confidence" TEXT NOT NULL,
    "n" INTEGER NOT NULL,
    "rate" DOUBLE PRECISION,
    "ciLo" DOUBLE PRECISION,
    "ciHi" DOUBLE PRECISION,
    "bandLo" DOUBLE PRECISION,
    "bandHi" DOUBLE PRECISION,
    "evLossBB" DOUBLE PRECISION,
    "recentN" INTEGER NOT NULL DEFAULT 0,
    "recentRate" DOUBLE PRECISION,
    "recentVerdict" TEXT,
    "examples" TEXT[],
    "lastSeenAt" TIMESTAMP(3),
    "drillCount" INTEGER NOT NULL DEFAULT 0,
    "lastDrilledAt" TIMESTAMP(3),
    "lastDrillAccuracy" DOUBLE PRECISION,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeakMemory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeakSnapshot" (
    "id" TEXT NOT NULL,
    "memoryId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL,
    "n" INTEGER NOT NULL,
    "rate" DOUBLE PRECISION,
    "ciLo" DOUBLE PRECISION,
    "ciHi" DOUBLE PRECISION,
    "severity" DOUBLE PRECISION NOT NULL,
    "evLossBB" DOUBLE PRECISION,
    "recentN" INTEGER NOT NULL DEFAULT 0,
    "recentRate" DOUBLE PRECISION,
    "drillAccuracy" DOUBLE PRECISION,

    CONSTRAINT "LeakSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeakMemoryState" (
    "userId" TEXT NOT NULL,
    "refreshedAt" TIMESTAMP(3) NOT NULL,
    "decisions" INTEGER NOT NULL,
    "engine" TEXT NOT NULL,

    CONSTRAINT "LeakMemoryState_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE INDEX "LeakMemory_userId_status_idx" ON "LeakMemory"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "LeakMemory_userId_leakKey_key" ON "LeakMemory"("userId", "leakKey");

-- CreateIndex
CREATE INDEX "LeakSnapshot_memoryId_at_idx" ON "LeakSnapshot"("memoryId", "at");

-- AddForeignKey
ALTER TABLE "LeakMemory" ADD CONSTRAINT "LeakMemory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeakSnapshot" ADD CONSTRAINT "LeakSnapshot_memoryId_fkey" FOREIGN KEY ("memoryId") REFERENCES "LeakMemory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeakMemoryState" ADD CONSTRAINT "LeakMemoryState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
