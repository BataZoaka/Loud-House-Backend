import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, StakeStatus, TicketReason } from '@prisma/client';
import { PrismaService } from '@/common/prisma/prisma.service';
import { OwnershipService } from '@/modules/chain/ownership.service';
import { TicketsService } from '@/modules/tickets/tickets.service';
import { STAKE_TIERS, getStakeTier } from '@/config/staking.config';
import { CreateStakeDto, StakeViewDto } from './dto/staking.dto';

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class StakingService {
  private readonly logger = new Logger(StakingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ownership: OwnershipService,
    private readonly tickets: TicketsService,
  ) {}

  /** The tier cards across the top of the Stake page. */
  getTiers() {
    return STAKE_TIERS.map((tier) => ({
      duration: tier.duration,
      days: tier.days,
      tickets: tier.tickets,
      label: tier.label,
      rewardLabel: `EARN ${tier.tickets} TICKET${tier.tickets === 1 ? '' : 'S'}`,
    }));
  }

  /**
   * Everything the Stake page needs in one request: held tenants, which are
   * still available to lock, the active locks, and the ticket balance.
   *
   * One endpoint rather than four because the page shows "3 ELIGIBLE / 9 HELD"
   * — a figure that only makes sense if both numbers come from the same instant.
   * Fetch them separately and a stake landing in between makes the header lie.
   */
  async getVault(userId: string, walletAddress: string) {
    const [held, activeStakes, balance] = await Promise.all([
      this.prisma.nft.findMany({
        where: { ownerAddress: walletAddress.toLowerCase() },
        orderBy: { tokenId: 'asc' },
        select: {
          id: true,
          tokenId: true,
          name: true,
          imageUrl: true,
          thumbnailUrl: true,
          background: true,
        },
      }),
      this.prisma.stake.findMany({
        where: { userId, status: StakeStatus.ACTIVE },
        orderBy: { endsAt: 'asc' },
        include: {
          nft: { select: { tokenId: true, name: true, imageUrl: true, thumbnailUrl: true } },
        },
      }),
      this.tickets.getBalance(userId),
    ]);

    const stakedNftIds = new Set(activeStakes.map((stake) => stake.nftId));
    const available = held.filter((nft) => !stakedNftIds.has(nft.id));

    return {
      ticketBalance: balance,
      totalHeld: held.length,
      totalEligible: available.length,
      availableTenants: available,
      activeStakes: activeStakes.map((stake) => this.toStakeView(stake)),
      tiers: this.getTiers(),
    };
  }

  /**
   * Lock a tenant in the vault.
   *
   * Order of checks is deliberate — cheap and local first, network last, so a
   * request that was never going to succeed does not cost us an RPC call.
   */
  async stake(userId: string, walletAddress: string, dto: CreateStakeDto): Promise<StakeViewDto> {
    const tier = getStakeTier(dto.duration);

    const nft = await this.prisma.nft.findUnique({ where: { tokenId: dto.tokenId } });
    if (!nft) {
      throw new NotFoundException(`Tenant #${dto.tokenId} is not part of this collection`);
    }

    // Ownership is the one check that cannot be skipped. Staking is off-chain,
    // so this is the only thing stopping someone farming tickets on a tenant
    // they do not hold.
    const owns = await this.ownership.assertOwns(walletAddress, dto.tokenId);
    if (!owns) {
      throw new ForbiddenException(`You do not own tenant #${dto.tokenId}`);
    }

    const now = new Date();
    const endsAt = new Date(now.getTime() + tier.days * DAY_MS);

    try {
      const stake = await this.prisma.stake.create({
        data: {
          userId,
          nftId: nft.id,
          // Mirrors nftId while ACTIVE; nulled on withdrawal. The unique index
          // on this column is what makes a double-stake impossible.
          activeNftId: nft.id,
          duration: dto.duration,
          status: StakeStatus.ACTIVE,
          ticketsEarned: tier.tickets,
          startsAt: now,
          endsAt,
          ownerAddressAtStake: walletAddress.toLowerCase(),
        },
        include: {
          nft: { select: { tokenId: true, name: true, imageUrl: true, thumbnailUrl: true } },
        },
      });

      return this.toStakeView(stake);
    } catch (error) {
      // P2002 = unique constraint violation. Here it can only mean activeNftId
      // was taken, i.e. this tenant is already locked. Catching the database
      // error instead of pre-checking with a SELECT is what closes the race:
      // two simultaneous requests both pass a pre-check, but only one can win
      // the insert.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new BadRequestException(`Tenant #${dto.tokenId} is already staked`);
      }
      throw error;
    }
  }

  /**
   * Withdraw a matured lock and credit its tickets.
   *
   * The whole thing is one transaction: the stake flips to WITHDRAWN and the
   * ledger row is written together, or neither happens. A partial failure here
   * either strands a tenant in the vault forever or pays out twice.
   */
  async unstake(userId: string, walletAddress: string, stakeId: string): Promise<StakeViewDto> {
    const stake = await this.prisma.stake.findUnique({
      where: { id: stakeId },
      include: {
        nft: { select: { tokenId: true, name: true, imageUrl: true, thumbnailUrl: true } },
      },
    });

    if (!stake) {
      throw new NotFoundException('Stake not found');
    }
    // Checked before anything else: never let one user act on another's stake.
    if (stake.userId !== userId) {
      throw new ForbiddenException('This stake does not belong to you');
    }
    if (stake.status !== StakeStatus.ACTIVE) {
      throw new BadRequestException('This stake has already been withdrawn');
    }
    if (stake.endsAt.getTime() > Date.now()) {
      throw new BadRequestException(
        `Still locked — ${Math.ceil((stake.endsAt.getTime() - Date.now()) / DAY_MS)} day(s) remaining`,
      );
    }

    // Re-verify ownership at exit, not just at entry. Otherwise the exploit is:
    // stake a tenant, sell it the next day, come back at maturity and collect
    // rewards for holding something you have not held in a month.
    const stillOwns = await this.ownership.assertOwns(walletAddress, stake.nft.tokenId);

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.stake.update({
        where: { id: stake.id },
        data: {
          status: stillOwns ? StakeStatus.WITHDRAWN : StakeStatus.CANCELLED,
          // Releasing the slot so the tenant can be staked again.
          activeNftId: null,
          withdrawnAt: new Date(),
        },
        include: {
          nft: { select: { tokenId: true, name: true, imageUrl: true, thumbnailUrl: true } },
        },
      });

      if (stillOwns) {
        // stakeId is unique on TicketLedger, so even if this request is
        // replayed the second insert is rejected by the database. Idempotency
        // you cannot forget to implement.
        await this.tickets.credit(tx, {
          userId,
          amount: stake.ticketsEarned,
          reason: TicketReason.STAKE_REWARD,
          stakeId: stake.id,
          note: `${getStakeTier(stake.duration).days}-day lock on #${stake.nft.tokenId}`,
        });
      } else {
        this.logger.warn(
          `Stake ${stake.id} cancelled without reward: ${walletAddress} no longer holds #${stake.nft.tokenId}`,
        );
      }

      return result;
    });

    return this.toStakeView(updated);
  }

  /**
   * Turns a stake row into what the UI renders. All the time-based state is
   * computed right here, at read time.
   */
  private toStakeView(
    stake: Prisma.StakeGetPayload<{
      include: { nft: { select: { tokenId: true; name: true; imageUrl: true; thumbnailUrl: true } } };
    }>,
  ): StakeViewDto {
    const remaining = Math.max(0, stake.endsAt.getTime() - Date.now());
    const isLocked = remaining > 0;

    return {
      id: stake.id,
      tokenId: stake.nft.tokenId,
      name: stake.nft.name,
      imageUrl: stake.nft.thumbnailUrl ?? stake.nft.imageUrl,
      duration: stake.duration,
      durationDays: getStakeTier(stake.duration).days,
      ticketsEarned: stake.ticketsEarned,
      startsAt: stake.startsAt,
      endsAt: stake.endsAt,
      isLocked,
      timeRemainingMs: remaining,
      canUnstake: !isLocked && stake.status === StakeStatus.ACTIVE,
    };
  }
}
