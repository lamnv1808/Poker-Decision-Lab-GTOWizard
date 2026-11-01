-- AlterTable
ALTER TABLE "RealDecision" ADD COLUMN     "actionContext" TEXT,
ADD COLUMN     "contextV" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "facingBetPct" DOUBLE PRECISION,
ADD COLUMN     "formatGroup" TEXT,
ADD COLUMN     "heroAction" TEXT,
ADD COLUMN     "heroClass" TEXT,
ADD COLUMN     "position" TEXT,
ADD COLUMN     "requiredEq" DOUBLE PRECISION,
ADD COLUMN     "spr" DOUBLE PRECISION,
ADD COLUMN     "stackBucket" TEXT;

-- CreateIndex
CREATE INDEX "RealDecision_userId_street_actionContext_idx" ON "RealDecision"("userId", "street", "actionContext");
