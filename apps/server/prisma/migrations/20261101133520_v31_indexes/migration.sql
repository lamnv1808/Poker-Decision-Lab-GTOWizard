-- CreateIndex
CREATE INDEX "DecisionAttempt_userId_familyId_idx" ON "DecisionAttempt"("userId", "familyId");

-- CreateIndex
CREATE INDEX "DecisionAttempt_sessionId_idx" ON "DecisionAttempt"("sessionId");
