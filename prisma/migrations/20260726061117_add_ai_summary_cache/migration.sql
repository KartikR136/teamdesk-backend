-- CreateTable
CREATE TABLE "AISummaryCache" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "headline" TEXT NOT NULL,
    "bullets" JSONB NOT NULL,
    "contextHash" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AISummaryCache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AISummaryCache_userId_generatedAt_idx" ON "AISummaryCache"("userId", "generatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AISummaryCache_userId_key" ON "AISummaryCache"("userId");

-- AddForeignKey
ALTER TABLE "AISummaryCache" ADD CONSTRAINT "AISummaryCache_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
