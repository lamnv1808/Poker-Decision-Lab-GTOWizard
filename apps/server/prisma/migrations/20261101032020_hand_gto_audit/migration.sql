-- AlterTable
ALTER TABLE "HandHistory" ADD COLUMN     "gtoAudit" JSONB,
ADD COLUMN     "hasGtoSpot" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "HandHistory_userId_hasGtoSpot_idx" ON "HandHistory"("userId", "hasGtoSpot");
