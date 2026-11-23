-- Users & Activity, cookie consent audit, page views, admin PDF/template control (owner applies with prisma migrate deploy).

-- AlterTable
ALTER TABLE "LoginEvent" ADD COLUMN     "browser" TEXT,
ADD COLUMN     "countryCode" TEXT,
ADD COLUMN     "device" TEXT,
ADD COLUMN     "enrichedAt" TIMESTAMP(3),
ADD COLUMN     "os" TEXT,
ADD COLUMN     "region" TEXT;

-- CreateTable
CREATE TABLE "ConsentLog" (
    "id" TEXT NOT NULL,
    "anonId" TEXT NOT NULL,
    "userId" TEXT,
    "version" INTEGER NOT NULL,
    "preferences" BOOLEAN NOT NULL DEFAULT false,
    "analytics" BOOLEAN NOT NULL DEFAULT false,
    "marketing" BOOLEAN NOT NULL DEFAULT false,
    "action" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsentLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PageView" (
    "id" TEXT NOT NULL,
    "anonId" TEXT NOT NULL,
    "userId" TEXT,
    "path" TEXT NOT NULL,
    "referrer" TEXT,
    "device" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PageView_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TemplateSetting" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "category" TEXT,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TemplateSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExportEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "resumeId" TEXT,
    "templateId" TEXT,
    "format" TEXT NOT NULL,
    "pageSize" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExportEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AdminAuditLog" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "adminEmail" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "details" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConsentLog_anonId_idx" ON "ConsentLog"("anonId");

-- CreateIndex
CREATE INDEX "ConsentLog_createdAt_idx" ON "ConsentLog"("createdAt");

-- CreateIndex
CREATE INDEX "PageView_createdAt_idx" ON "PageView"("createdAt");

-- CreateIndex
CREATE INDEX "PageView_path_idx" ON "PageView"("path");

-- CreateIndex
CREATE INDEX "PageView_userId_idx" ON "PageView"("userId");

-- CreateIndex
CREATE INDEX "ExportEvent_userId_createdAt_idx" ON "ExportEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ExportEvent_resumeId_idx" ON "ExportEvent"("resumeId");

-- CreateIndex
CREATE INDEX "ExportEvent_createdAt_idx" ON "ExportEvent"("createdAt");

-- CreateIndex
CREATE INDEX "AdminAuditLog_createdAt_idx" ON "AdminAuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AdminAuditLog_adminId_idx" ON "AdminAuditLog"("adminId");

-- CreateIndex
CREATE INDEX "AdminAuditLog_targetType_targetId_idx" ON "AdminAuditLog"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "LoginEvent_device_idx" ON "LoginEvent"("device");

-- CreateIndex
CREATE INDEX "LoginEvent_enrichedAt_idx" ON "LoginEvent"("enrichedAt");

-- AddForeignKey
ALTER TABLE "ExportEvent" ADD CONSTRAINT "ExportEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
