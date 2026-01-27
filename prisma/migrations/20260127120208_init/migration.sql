-- CreateEnum
CREATE TYPE "TeamType" AS ENUM ('DUO', 'TRIO', 'SQUAD');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('PENDING', 'OPEN', 'CLAIMED', 'CLOSED');

-- CreateTable
CREATE TABLE "GuildSettings" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "interfaceVcId" TEXT,
    "interfaceTextId" TEXT,
    "commandChannelId" TEXT,
    "logsChannelId" TEXT,
    "logsWebhookUrl" TEXT,
    "staffRoleId" TEXT,
    "adminStrictness" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuildSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PendingRenameRequest" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "newName" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingRenameRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrivateVoiceChannel" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "isHidden" BOOLEAN NOT NULL DEFAULT false,
    "userLimit" INTEGER NOT NULL DEFAULT 0,
    "bitrate" INTEGER NOT NULL DEFAULT 64000,
    "rtcRegion" TEXT,
    "videoQualityMode" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "PrivateVoiceChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoicePermission" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VoicePermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StrictnessWhitelist" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StrictnessWhitelist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OwnerPermission" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OwnerPermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PvcOwner" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "addedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PvcOwner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamVoiceSettings" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "categoryId" TEXT,
    "duoVcId" TEXT,
    "trioVcId" TEXT,
    "squadVcId" TEXT,
    "logsChannelId" TEXT,
    "logsWebhookUrl" TEXT,
    "commandChannelId" TEXT,
    "adminStrictness" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamVoiceSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamVoiceChannel" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "teamType" "TeamType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "isHidden" BOOLEAN NOT NULL DEFAULT false,
    "userLimit" INTEGER NOT NULL DEFAULT 0,
    "bitrate" INTEGER NOT NULL DEFAULT 64000,
    "rtcRegion" TEXT,
    "videoQualityMode" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "TeamVoiceChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamVoicePermission" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamVoicePermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserAccessGrant" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "grantCount" INTEGER NOT NULL DEFAULT 1,
    "lastGrantAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "suggested" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserAccessGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GlobalVCBlock" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "blockedBy" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GlobalVCBlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WvAllowedRole" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "addedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WvAllowedRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModMailSettings" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "categoryId" TEXT,
    "closedCategoryId" TEXT,
    "logsChannelId" TEXT,
    "staffRoleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModMailSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModMailTicket" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channelId" TEXT,
    "messageId" TEXT,
    "status" "TicketStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "closedBy" TEXT,
    "staffClaimedBy" TEXT,

    CONSTRAINT "ModMailTicket_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GuildSettings_guildId_key" ON "GuildSettings"("guildId");

-- CreateIndex
CREATE INDEX "GuildSettings_guildId_idx" ON "GuildSettings"("guildId");

-- CreateIndex
CREATE UNIQUE INDEX "PendingRenameRequest_messageId_key" ON "PendingRenameRequest"("messageId");

-- CreateIndex
CREATE INDEX "PendingRenameRequest_guildId_idx" ON "PendingRenameRequest"("guildId");

-- CreateIndex
CREATE INDEX "PendingRenameRequest_userId_idx" ON "PendingRenameRequest"("userId");

-- CreateIndex
CREATE INDEX "PendingRenameRequest_messageId_idx" ON "PendingRenameRequest"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "PrivateVoiceChannel_channelId_key" ON "PrivateVoiceChannel"("channelId");

-- CreateIndex
CREATE INDEX "PrivateVoiceChannel_guildId_idx" ON "PrivateVoiceChannel"("guildId");

-- CreateIndex
CREATE INDEX "PrivateVoiceChannel_ownerId_idx" ON "PrivateVoiceChannel"("ownerId");

-- CreateIndex
CREATE INDEX "PrivateVoiceChannel_guildId_ownerId_idx" ON "PrivateVoiceChannel"("guildId", "ownerId");

-- CreateIndex
CREATE INDEX "VoicePermission_channelId_idx" ON "VoicePermission"("channelId");

-- CreateIndex
CREATE INDEX "VoicePermission_channelId_permission_idx" ON "VoicePermission"("channelId", "permission");

-- CreateIndex
CREATE UNIQUE INDEX "VoicePermission_channelId_targetId_key" ON "VoicePermission"("channelId", "targetId");

-- CreateIndex
CREATE INDEX "StrictnessWhitelist_guildId_idx" ON "StrictnessWhitelist"("guildId");

-- CreateIndex
CREATE UNIQUE INDEX "StrictnessWhitelist_guildId_targetId_key" ON "StrictnessWhitelist"("guildId", "targetId");

-- CreateIndex
CREATE INDEX "OwnerPermission_guildId_ownerId_idx" ON "OwnerPermission"("guildId", "ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "OwnerPermission_guildId_ownerId_targetId_key" ON "OwnerPermission"("guildId", "ownerId", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "PvcOwner_userId_key" ON "PvcOwner"("userId");

-- CreateIndex
CREATE INDEX "PvcOwner_userId_idx" ON "PvcOwner"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamVoiceSettings_guildId_key" ON "TeamVoiceSettings"("guildId");

-- CreateIndex
CREATE INDEX "TeamVoiceSettings_guildId_idx" ON "TeamVoiceSettings"("guildId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamVoiceChannel_channelId_key" ON "TeamVoiceChannel"("channelId");

-- CreateIndex
CREATE INDEX "TeamVoiceChannel_guildId_idx" ON "TeamVoiceChannel"("guildId");

-- CreateIndex
CREATE INDEX "TeamVoiceChannel_ownerId_idx" ON "TeamVoiceChannel"("ownerId");

-- CreateIndex
CREATE INDEX "TeamVoiceChannel_guildId_ownerId_idx" ON "TeamVoiceChannel"("guildId", "ownerId");

-- CreateIndex
CREATE INDEX "TeamVoicePermission_channelId_idx" ON "TeamVoicePermission"("channelId");

-- CreateIndex
CREATE INDEX "TeamVoicePermission_channelId_permission_idx" ON "TeamVoicePermission"("channelId", "permission");

-- CreateIndex
CREATE UNIQUE INDEX "TeamVoicePermission_channelId_targetId_key" ON "TeamVoicePermission"("channelId", "targetId");

-- CreateIndex
CREATE INDEX "UserAccessGrant_guildId_ownerId_idx" ON "UserAccessGrant"("guildId", "ownerId");

-- CreateIndex
CREATE INDEX "UserAccessGrant_guildId_ownerId_suggested_idx" ON "UserAccessGrant"("guildId", "ownerId", "suggested");

-- CreateIndex
CREATE UNIQUE INDEX "UserAccessGrant_guildId_ownerId_targetId_key" ON "UserAccessGrant"("guildId", "ownerId", "targetId");

-- CreateIndex
CREATE INDEX "GlobalVCBlock_guildId_idx" ON "GlobalVCBlock"("guildId");

-- CreateIndex
CREATE INDEX "GlobalVCBlock_userId_idx" ON "GlobalVCBlock"("userId");

-- CreateIndex
CREATE INDEX "GlobalVCBlock_guildId_userId_idx" ON "GlobalVCBlock"("guildId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "GlobalVCBlock_guildId_userId_key" ON "GlobalVCBlock"("guildId", "userId");

-- CreateIndex
CREATE INDEX "WvAllowedRole_guildId_idx" ON "WvAllowedRole"("guildId");

-- CreateIndex
CREATE UNIQUE INDEX "WvAllowedRole_guildId_roleId_key" ON "WvAllowedRole"("guildId", "roleId");

-- CreateIndex
CREATE UNIQUE INDEX "ModMailSettings_guildId_key" ON "ModMailSettings"("guildId");

-- CreateIndex
CREATE INDEX "ModMailSettings_guildId_idx" ON "ModMailSettings"("guildId");

-- CreateIndex
CREATE INDEX "ModMailTicket_guildId_idx" ON "ModMailTicket"("guildId");

-- CreateIndex
CREATE INDEX "ModMailTicket_userId_idx" ON "ModMailTicket"("userId");

-- CreateIndex
CREATE INDEX "ModMailTicket_channelId_idx" ON "ModMailTicket"("channelId");

-- CreateIndex
CREATE INDEX "ModMailTicket_status_idx" ON "ModMailTicket"("status");

-- AddForeignKey
ALTER TABLE "PendingRenameRequest" ADD CONSTRAINT "PendingRenameRequest_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "GuildSettings"("guildId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrivateVoiceChannel" ADD CONSTRAINT "PrivateVoiceChannel_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "GuildSettings"("guildId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoicePermission" ADD CONSTRAINT "VoicePermission_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "PrivateVoiceChannel"("channelId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamVoiceChannel" ADD CONSTRAINT "TeamVoiceChannel_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "TeamVoiceSettings"("guildId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamVoicePermission" ADD CONSTRAINT "TeamVoicePermission_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "TeamVoiceChannel"("channelId") ON DELETE CASCADE ON UPDATE CASCADE;
