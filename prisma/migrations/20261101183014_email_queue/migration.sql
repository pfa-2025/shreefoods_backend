-- AlterTable
ALTER TABLE "EmailLog" ADD COLUMN     "nextAttemptAt" TIMESTAMP(3),
ADD COLUMN     "payload" JSONB,
ADD COLUMN     "provider" TEXT,
ADD COLUMN     "subject" TEXT;

-- CreateIndex
CREATE INDEX "EmailLog_status_nextAttemptAt_idx" ON "EmailLog"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "EmailLog_orderId_idx" ON "EmailLog"("orderId");
