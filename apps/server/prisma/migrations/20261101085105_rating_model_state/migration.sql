-- CreateTable
CREATE TABLE "RatingModelState" (
    "userId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "migratedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "backfilled" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RatingModelState_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "RatingModelState" ADD CONSTRAINT "RatingModelState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
