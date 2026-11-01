-- CreateTable
CREATE TABLE "InviteCode" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "note" TEXT,
    "usedById" TEXT,
    "usedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InviteCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InviteCode_codeHash_key" ON "InviteCode"("codeHash");

-- CreateIndex
CREATE INDEX "InviteCode_createdById_idx" ON "InviteCode"("createdById");

-- AddForeignKey
ALTER TABLE "InviteCode" ADD CONSTRAINT "InviteCode_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
