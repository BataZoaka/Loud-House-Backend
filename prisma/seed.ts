/**
 * Development seed.
 *
 * Gives you a database you can actually click through: tenants with traits,
 * a demo holder, an open raffle with entries, and the artist/team content from
 * the landing page. Re-runnable — everything upserts, so `npm run db:seed`
 * twice does not duplicate rows.
 *
 *   npx prisma migrate dev && npm run db:seed
 */
import {
  PersonKind,
  PrismaClient,
  RaffleStatus,
  StakeDuration,
  StakeStatus,
  TicketReason,
} from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';

const prisma = new PrismaClient();

const BACKGROUNDS = ['Pink', 'Lime', 'Orange', 'Red', 'Blue', 'Grey', 'Cream'];
const HEADWEAR = ['Red Beret', 'Bandana', 'Cap #1', 'Durag', 'None', 'VR Headset'];
const EYEWEAR = ['Pixel Shades', 'Goggles', 'Laser Eyes', 'Round Glasses', 'None'];
const OUTFIT = ['Chef Whites', 'Bomber Jacket', 'Suit', 'Hoodie', 'Camo'];
const MOUTH = ['Cigar', 'Grin', 'Grill', 'Flat', 'Open'];

/** Deterministic pick, so re-seeding produces the same collection. */
const pick = <T>(list: T[], seed: number): T => list[seed % list.length];

const DEMO_WALLET = '0x71af6f0e1b2c3d4e5f60718293a4b5c6d7e8f900';
const SECOND_WALLET = '0x83b13ec0a1b2c3d4e5f60718293a4b5c6d7e8f11';

async function main() {
  console.log('Seeding The Loud House…');

  // --- Tenants -------------------------------------------------------------
  const TOTAL = 120; // a workable slice of the 3,000-piece edition
  const traitCounts = new Map<string, number>();

  for (let tokenId = 1; tokenId <= TOTAL; tokenId++) {
    const attributes = [
      { trait_type: 'Background', value: pick(BACKGROUNDS, tokenId * 3) },
      { trait_type: 'Headwear', value: pick(HEADWEAR, tokenId * 5) },
      { trait_type: 'Eyewear', value: pick(EYEWEAR, tokenId * 7) },
      { trait_type: 'Outfit', value: pick(OUTFIT, tokenId * 11) },
      { trait_type: 'Mouth', value: pick(MOUTH, tokenId * 13) },
    ];

    for (const attribute of attributes) {
      const key = `${attribute.trait_type}|${attribute.value}`;
      traitCounts.set(key, (traitCounts.get(key) ?? 0) + 1);
    }

    // The first three tenants belong to the demo wallet so the Stake page has
    // something in "AVAILABLE TENANTS" on first load.
    const ownerAddress =
      tokenId <= 3 ? DEMO_WALLET : tokenId <= 6 ? SECOND_WALLET : null;

    await prisma.nft.upsert({
      where: { tokenId },
      update: {},
      create: {
        tokenId,
        name: `Tenant #${String(tokenId).padStart(4, '0')}`,
        editionName: 'LOUD HEADS',
        imageUrl: `https://placehold.co/600x600/png?text=%23${String(tokenId).padStart(4, '0')}`,
        background: attributes[0].value,
        ownerAddress,
        metadata: { attributes },
      },
    });
  }
  console.log(`  ${TOTAL} tenants`);

  // --- Traits --------------------------------------------------------------
  for (const [key, count] of traitCounts) {
    const [traitType, value] = key.split('|');
    const trait = await prisma.trait.upsert({
      where: { traitType_value: { traitType, value } },
      update: { count, rarity: count / TOTAL },
      create: { traitType, value, count, rarity: count / TOTAL },
    });

    // Link every NFT carrying this trait.
    const owners = await prisma.nft.findMany({
      where: { metadata: { path: ['attributes'], array_contains: [{ trait_type: traitType, value }] } },
      select: { id: true },
    });

    for (const nft of owners) {
      await prisma.nftTrait.upsert({
        where: { nftId_traitId: { nftId: nft.id, traitId: trait.id } },
        update: {},
        create: { nftId: nft.id, traitId: trait.id },
      });
    }
  }
  console.log(`  ${traitCounts.size} distinct traits`);

  // --- Rarity --------------------------------------------------------------
  // Score = sum of 1/frequency across traits: the rarer each trait, the higher
  // the score. Rank 1 is the rarest tenant.
  const nfts = await prisma.nft.findMany({ include: { traits: { include: { trait: true } } } });
  const scored = nfts
    .map((nft) => ({
      id: nft.id,
      score: nft.traits.reduce((total, { trait }) => total + 1 / (trait.rarity || 1), 0),
    }))
    .sort((a, b) => b.score - a.score);

  for (const [index, entry] of scored.entries()) {
    await prisma.nft.update({
      where: { id: entry.id },
      data: { rarityScore: entry.score, rarityRank: index + 1 },
    });
  }
  console.log('  rarity ranked');

  // --- Users ---------------------------------------------------------------
  const demoUser = await prisma.user.upsert({
    where: { walletAddress: DEMO_WALLET },
    update: {},
    create: {
      walletAddress: DEMO_WALLET,
      nonce: randomBytes(16).toString('hex'),
      displayName: 'Demo Holder',
      isAdmin: true, // so you can hit the operator endpoints locally
    },
  });

  const secondUser = await prisma.user.upsert({
    where: { walletAddress: SECOND_WALLET },
    update: {},
    create: { walletAddress: SECOND_WALLET, nonce: randomBytes(16).toString('hex') },
  });
  console.log('  2 users (demo holder is an admin)');

  // --- A completed stake, so the demo wallet starts with tickets -----------
  const firstTenant = await prisma.nft.findUniqueOrThrow({ where: { tokenId: 1 } });
  const existingStake = await prisma.stake.findFirst({
    where: { userId: demoUser.id, nftId: firstTenant.id },
  });

  if (!existingStake) {
    const startsAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const stake = await prisma.stake.create({
      data: {
        userId: demoUser.id,
        nftId: firstTenant.id,
        activeNftId: null, // already withdrawn, so the slot is free
        duration: StakeDuration.DAYS_30,
        status: StakeStatus.WITHDRAWN,
        ticketsEarned: 3,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 30 * 24 * 60 * 60 * 1000),
        withdrawnAt: new Date(),
        ownerAddressAtStake: DEMO_WALLET,
      },
    });

    await prisma.ticketLedger.create({
      data: {
        userId: demoUser.id,
        delta: 3,
        reason: TicketReason.STAKE_REWARD,
        stakeId: stake.id,
        note: '30-day lock on #0001',
      },
    });
    console.log('  demo holder credited 3 tickets from a completed lock');
  }

  // --- An open raffle ------------------------------------------------------
  const prize = await prisma.nft.findUniqueOrThrow({ where: { tokenId: 103 } });
  const serverSeed = randomBytes(32).toString('hex');

  const raffle = await prisma.raffle.upsert({
    where: { slug: 'tenant-0103-camo-stalk' },
    update: {},
    create: {
      slug: 'tenant-0103-camo-stalk',
      title: 'TENANT #0103 — 1/1 CAMO STALK',
      subtitle: 'THE LOUD HOUSE / GENESIS DOLLS',
      prizeNftId: prize.id,
      status: RaffleStatus.OPEN,
      entryCost: 1,
      minTicketsToEnter: 1,
      opensAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      closesAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
      serverSeed,
      serverSeedHash: createHash('sha256').update(serverSeed).digest('hex'),
    },
  });

  // A few entries so the TICKET STRIP is not empty.
  const entryCount = await prisma.raffleEntry.count({ where: { raffleId: raffle.id } });
  if (entryCount === 0) {
    for (let i = 0; i < 4; i++) {
      await prisma.raffleEntry.create({
        data: {
          raffleId: raffle.id,
          userId: secondUser.id,
          walletAddress: SECOND_WALLET,
        },
      });
    }
    await prisma.raffle.update({
      where: { id: raffle.id },
      data: { entryCount: 4 },
    });
    console.log('  1 open raffle with 4 entries');
  }

  // --- Landing page content ------------------------------------------------
  const people = [
    { slug: 'mako', name: 'MAKO', kind: PersonKind.ARTIST, role: 'Artist', sortOrder: 1 },
    { slug: 'vela', name: 'VELA', kind: PersonKind.ARTIST, role: 'Artist', sortOrder: 2 },
    { slug: 'oku', name: 'OKU', kind: PersonKind.ARTIST, role: 'Artist', sortOrder: 3 },
    { slug: 'rin', name: 'RIN', kind: PersonKind.TEAM, role: 'Founder', sortOrder: 1 },
    { slug: 'baz', name: 'BAZ', kind: PersonKind.TEAM, role: 'Operations', sortOrder: 2 },
  ];

  for (const person of people) {
    await prisma.person.upsert({
      where: { slug: person.slug },
      update: {},
      create: person,
    });
  }
  console.log(`  ${people.length} artists and humans`);

  console.log('\nDone. Demo wallet:', DEMO_WALLET);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
