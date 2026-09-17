import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@/common/prisma/prisma.service';
import { paginated } from '@/common/dto/pagination.dto';
import { NftSort, QueryNftsDto } from './dto/query-nfts.dto';

@Injectable()
export class CollectionService {
  constructor(private readonly prisma: PrismaService) {}

  /** The CATALOGUE grid: "SHOWING 1-24 OF 3,000". */
  async findAll(query: QueryNftsDto) {
    const where = this.buildWhere(query);

    // One $transaction so the rows and the count come from the same snapshot.
    // Run separately, a write landing in between makes "SHOWING 1-24 OF 3,000"
    // disagree with the grid beneath it.
    const [items, total] = await this.prisma.$transaction([
      this.prisma.nft.findMany({
        where,
        orderBy: this.buildOrderBy(query.sort),
        skip: query.skip,
        take: query.limit,
        select: {
          id: true,
          tokenId: true,
          name: true,
          editionName: true,
          imageUrl: true,
          thumbnailUrl: true,
          background: true,
          rarityRank: true,
          ownerAddress: true,
        },
      }),
      this.prisma.nft.count({ where }),
    ]);

    return paginated(items, total, query);
  }

  async findByTokenId(tokenId: number) {
    const nft = await this.prisma.nft.findUnique({
      where: { tokenId },
      include: {
        traits: { include: { trait: true } },
        stakes: {
          where: { status: 'ACTIVE' },
          select: { id: true, endsAt: true, duration: true },
        },
      },
    });

    if (!nft) throw new NotFoundException(`Tenant #${tokenId} not found`);

    const activeStake = nft.stakes[0] ?? null;

    return {
      id: nft.id,
      tokenId: nft.tokenId,
      name: nft.name,
      editionName: nft.editionName,
      description: nft.description,
      imageUrl: nft.imageUrl,
      animationUrl: nft.animationUrl,
      background: nft.background,
      ownerAddress: nft.ownerAddress,
      rarityRank: nft.rarityRank,
      rarityScore: nft.rarityScore,
      traits: nft.traits.map(({ trait }) => ({
        traitType: trait.traitType,
        value: trait.value,
        count: trait.count,
        rarity: trait.rarity,
      })),
      isStaked: activeStake !== null,
      stakedUntil: activeStake?.endsAt ?? null,
    };
  }

  /**
   * Powers the filter dropdowns. Reads the Trait table directly rather than
   * scanning 3,000 metadata blobs — the whole reason traits are normalised.
   */
  async getTraitFilters() {
    const traits = await this.prisma.trait.findMany({
      orderBy: [{ traitType: 'asc' }, { count: 'desc' }],
      select: { traitType: true, value: true, count: true, rarity: true },
    });

    const grouped = new Map<string, typeof traits>();
    for (const trait of traits) {
      const bucket = grouped.get(trait.traitType) ?? [];
      bucket.push(trait);
      grouped.set(trait.traitType, bucket);
    }

    return [...grouped.entries()].map(([traitType, values]) => ({ traitType, values }));
  }

  /** Header stats: total supply, unique holders, how many are locked. */
  async getStats() {
    const [totalSupply, holders, staked] = await this.prisma.$transaction([
      this.prisma.nft.count(),
      this.prisma.nft.findMany({
        where: { ownerAddress: { not: null } },
        distinct: ['ownerAddress'],
        select: { ownerAddress: true },
      }),
      this.prisma.stake.count({ where: { status: 'ACTIVE' } }),
    ]);

    return { totalSupply, uniqueHolders: holders.length, stakedCount: staked };
  }

  private buildWhere(query: QueryNftsDto): Prisma.NftWhereInput {
    const where: Prisma.NftWhereInput = {};

    if (query.background) where.background = query.background;
    if (query.owner) where.ownerAddress = query.owner;
    if (query.maxRarityRank) where.rarityRank = { lte: query.maxRarityRank };

    if (query.traitType && query.traitValue) {
      where.traits = {
        some: { trait: { traitType: query.traitType, value: query.traitValue } },
      };
    }

    if (query.search) {
      // "#0001", "0001" and "1" should all find token 1, so we strip the hash
      // and any leading zeros before trying to parse a number.
      const asNumber = Number.parseInt(query.search.replace(/^#/, ''), 10);
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        ...(Number.isNaN(asNumber) ? [] : [{ tokenId: asNumber }]),
      ];
    }

    return where;
  }

  private buildOrderBy(sort: NftSort): Prisma.NftOrderByWithRelationInput[] {
    switch (sort) {
      case NftSort.TOKEN_ID_DESC:
        return [{ tokenId: 'desc' }];
      case NftSort.RARITY_ASC:
        // nulls last: tenants not yet ranked should not lead the grid.
        return [{ rarityRank: { sort: 'asc', nulls: 'last' } }, { tokenId: 'asc' }];
      case NftSort.RARITY_DESC:
        return [{ rarityRank: { sort: 'desc', nulls: 'last' } }, { tokenId: 'asc' }];
      case NftSort.TOKEN_ID_ASC:
      default:
        return [{ tokenId: 'asc' }];
    }
  }
}
