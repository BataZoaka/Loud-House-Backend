-- CreateEnum
CREATE TYPE "StakeDuration" AS ENUM ('DAYS_7', 'DAYS_14', 'DAYS_30', 'DAYS_60', 'DAYS_90');

-- CreateEnum
CREATE TYPE "StakeStatus" AS ENUM ('ACTIVE', 'WITHDRAWN', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TicketReason" AS ENUM ('STAKE_REWARD', 'RAFFLE_ENTRY', 'RAFFLE_REFUND', 'ADMIN_ADJUSTMENT');

-- CreateEnum
CREATE TYPE "RaffleStatus" AS ENUM ('SCHEDULED', 'OPEN', 'CLOSED', 'DRAWN', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PersonKind" AS ENUM ('ARTIST', 'TEAM');

-- CreateTable
CREATE TABLE "nfts" (
    "id" TEXT NOT NULL,
    "tokenId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "editionName" TEXT,
    "description" TEXT,
    "imageUrl" TEXT NOT NULL,
    "thumbnailUrl" TEXT,
    "animationUrl" TEXT,
    "background" TEXT,
    "metadata" JSONB,
    "ownerAddress" TEXT,
    "rarityScore" DOUBLE PRECISION,
    "rarityRank" INTEGER,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "nfts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "traits" (
    "id" TEXT NOT NULL,
    "traitType" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "rarity" DOUBLE PRECISION,

    CONSTRAINT "traits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nft_traits" (
    "nftId" TEXT NOT NULL,
    "traitId" TEXT NOT NULL,

    CONSTRAINT "nft_traits_pkey" PRIMARY KEY ("nftId","traitId")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "nonceExpiresAt" TIMESTAMP(3),
    "displayName" TEXT,
    "avatarUrl" TEXT,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "isBanned" BOOLEAN NOT NULL DEFAULT false,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stakes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "nftId" TEXT NOT NULL,
    "duration" "StakeDuration" NOT NULL,
    "status" "StakeStatus" NOT NULL DEFAULT 'ACTIVE',
    "ticketsEarned" INTEGER NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "withdrawnAt" TIMESTAMP(3),
    "ownerAddressAtStake" TEXT NOT NULL,
    "activeNftId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stakes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_ledger" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" "TicketReason" NOT NULL,
    "note" TEXT,
    "stakeId" TEXT,
    "raffleEntryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "raffles" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "description" TEXT,
    "prizeNftId" TEXT,
    "prizeLabel" TEXT,
    "prizeImageUrl" TEXT,
    "status" "RaffleStatus" NOT NULL DEFAULT 'SCHEDULED',
    "entryCost" INTEGER NOT NULL DEFAULT 1,
    "minTicketsToEnter" INTEGER NOT NULL DEFAULT 1,
    "maxEntriesPerUser" INTEGER,
    "opensAt" TIMESTAMP(3) NOT NULL,
    "closesAt" TIMESTAMP(3) NOT NULL,
    "drawnAt" TIMESTAMP(3),
    "entryCount" INTEGER NOT NULL DEFAULT 0,
    "serverSeedHash" TEXT NOT NULL,
    "serverSeed" TEXT,
    "entropyBlockNumber" BIGINT,
    "entropyBlockHash" TEXT,
    "drawHash" TEXT,
    "winningEntryId" TEXT,
    "winnerUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "raffles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "raffle_entries" (
    "id" TEXT NOT NULL,
    "entryNumber" SERIAL NOT NULL,
    "raffleId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "raffle_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "snapshots" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "blockNumber" BIGINT,
    "takenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "totalHolders" INTEGER NOT NULL DEFAULT 0,
    "totalSupply" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "snapshot_holdings" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "balance" INTEGER NOT NULL,
    "tokenIds" INTEGER[],

    CONSTRAINT "snapshot_holdings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "people" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "PersonKind" NOT NULL,
    "role" TEXT,
    "bio" TEXT,
    "imageUrl" TEXT,
    "links" JSONB,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isVisible" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "people_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "nfts_tokenId_key" ON "nfts"("tokenId");

-- CreateIndex
CREATE INDEX "nfts_ownerAddress_idx" ON "nfts"("ownerAddress");

-- CreateIndex
CREATE INDEX "nfts_background_idx" ON "nfts"("background");

-- CreateIndex
CREATE INDEX "nfts_rarityRank_idx" ON "nfts"("rarityRank");

-- CreateIndex
CREATE INDEX "traits_traitType_idx" ON "traits"("traitType");

-- CreateIndex
CREATE UNIQUE INDEX "traits_traitType_value_key" ON "traits"("traitType", "value");

-- CreateIndex
CREATE INDEX "nft_traits_traitId_idx" ON "nft_traits"("traitId");

-- CreateIndex
CREATE UNIQUE INDEX "users_walletAddress_key" ON "users"("walletAddress");

-- CreateIndex
CREATE UNIQUE INDEX "stakes_activeNftId_key" ON "stakes"("activeNftId");

-- CreateIndex
CREATE INDEX "stakes_userId_status_idx" ON "stakes"("userId", "status");

-- CreateIndex
CREATE INDEX "stakes_endsAt_idx" ON "stakes"("endsAt");

-- CreateIndex
CREATE UNIQUE INDEX "ticket_ledger_stakeId_key" ON "ticket_ledger"("stakeId");

-- CreateIndex
CREATE UNIQUE INDEX "ticket_ledger_raffleEntryId_key" ON "ticket_ledger"("raffleEntryId");

-- CreateIndex
CREATE INDEX "ticket_ledger_userId_createdAt_idx" ON "ticket_ledger"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "raffles_slug_key" ON "raffles"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "raffles_winningEntryId_key" ON "raffles"("winningEntryId");

-- CreateIndex
CREATE INDEX "raffles_status_closesAt_idx" ON "raffles"("status", "closesAt");

-- CreateIndex
CREATE UNIQUE INDEX "raffle_entries_entryNumber_key" ON "raffle_entries"("entryNumber");

-- CreateIndex
CREATE INDEX "raffle_entries_raffleId_createdAt_idx" ON "raffle_entries"("raffleId", "createdAt");

-- CreateIndex
CREATE INDEX "raffle_entries_userId_raffleId_idx" ON "raffle_entries"("userId", "raffleId");

-- CreateIndex
CREATE INDEX "snapshot_holdings_walletAddress_idx" ON "snapshot_holdings"("walletAddress");

-- CreateIndex
CREATE UNIQUE INDEX "snapshot_holdings_snapshotId_walletAddress_key" ON "snapshot_holdings"("snapshotId", "walletAddress");

-- CreateIndex
CREATE UNIQUE INDEX "people_slug_key" ON "people"("slug");

-- CreateIndex
CREATE INDEX "people_kind_sortOrder_idx" ON "people"("kind", "sortOrder");

-- AddForeignKey
ALTER TABLE "nft_traits" ADD CONSTRAINT "nft_traits_nftId_fkey" FOREIGN KEY ("nftId") REFERENCES "nfts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nft_traits" ADD CONSTRAINT "nft_traits_traitId_fkey" FOREIGN KEY ("traitId") REFERENCES "traits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stakes" ADD CONSTRAINT "stakes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stakes" ADD CONSTRAINT "stakes_nftId_fkey" FOREIGN KEY ("nftId") REFERENCES "nfts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_ledger" ADD CONSTRAINT "ticket_ledger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_ledger" ADD CONSTRAINT "ticket_ledger_stakeId_fkey" FOREIGN KEY ("stakeId") REFERENCES "stakes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_ledger" ADD CONSTRAINT "ticket_ledger_raffleEntryId_fkey" FOREIGN KEY ("raffleEntryId") REFERENCES "raffle_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raffles" ADD CONSTRAINT "raffles_prizeNftId_fkey" FOREIGN KEY ("prizeNftId") REFERENCES "nfts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raffles" ADD CONSTRAINT "raffles_winningEntryId_fkey" FOREIGN KEY ("winningEntryId") REFERENCES "raffle_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raffles" ADD CONSTRAINT "raffles_winnerUserId_fkey" FOREIGN KEY ("winnerUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raffle_entries" ADD CONSTRAINT "raffle_entries_raffleId_fkey" FOREIGN KEY ("raffleId") REFERENCES "raffles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raffle_entries" ADD CONSTRAINT "raffle_entries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "snapshot_holdings" ADD CONSTRAINT "snapshot_holdings_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
