import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma, TicketReason } from '@prisma/client';
import { PrismaService } from '@/common/prisma/prisma.service';

/** Prisma's transaction client — what you get inside `prisma.$transaction`. */
type Tx = Prisma.TransactionClient;

@Injectable()
export class TicketsService {
  private readonly logger = new Logger(TicketsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Current balance = the sum of the ledger. Never a stored column.
   *
   * Yes, this is an aggregate on every call. With an index on (userId,
   * createdAt) it stays cheap well past the size this collection will reach.
   * If it ever does become hot, the fix is a cached projection you can always
   * rebuild from the ledger — not making the ledger itself mutable.
   */
  async getBalance(userId: string, tx: Tx | PrismaService = this.prisma): Promise<number> {
    const result = await tx.ticketLedger.aggregate({
      where: { userId },
      _sum: { delta: true },
    });
    return result._sum.delta ?? 0;
  }

  /**
   * Total tickets ever earned, ignoring spending. Feeds the "+5 TICKETS EARNED
   * THROUGH STAKING / THIS CYCLE" figure on the raffle page.
   */
  async getEarnedSince(userId: string, since: Date): Promise<number> {
    const result = await this.prisma.ticketLedger.aggregate({
      where: { userId, delta: { gt: 0 }, createdAt: { gte: since } },
      _sum: { delta: true },
    });
    return result._sum.delta ?? 0;
  }

  /**
   * Locks the user's row for the rest of the transaction.
   *
   * This is the bit that actually prevents double-spending, and it is worth
   * understanding properly because the ledger alone does NOT prevent it.
   *
   * Picture a user with 1 ticket double-clicking "ENTER RAFFLE":
   *
   *   tx A: SUM(delta) -> 1    tx B: SUM(delta) -> 1
   *   tx A: 1 >= 1, ok         tx B: 1 >= 1, ok
   *   tx A: INSERT -1          tx B: INSERT -1
   *   -> balance is now -1, and they entered twice on one ticket.
   *
   * Both transactions read before either wrote, so neither saw the other. The
   * unique index on raffleEntryId does not help — these are two DIFFERENT
   * entries, each debited once.
   *
   * `SELECT ... FOR UPDATE` makes tx B block at this line until tx A commits,
   * so B's SUM query runs afterwards and correctly returns 0. Spending is
   * serialised per user, and only per user — other holders are unaffected.
   */
  private async lockUser(tx: Tx, userId: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
  }

  /**
   * Adds tickets. Must be called inside a transaction that also writes
   * whatever justifies the credit, so the two commit or fail together.
   */
  async credit(
    tx: Tx,
    params: {
      userId: string;
      amount: number;
      reason: TicketReason;
      stakeId?: string;
      raffleEntryId?: string;
      note?: string;
    },
  ) {
    if (params.amount <= 0) {
      throw new BadRequestException('Credit amount must be positive');
    }

    return tx.ticketLedger.create({
      data: {
        userId: params.userId,
        delta: params.amount,
        reason: params.reason,
        stakeId: params.stakeId,
        raffleEntryId: params.raffleEntryId,
        note: params.note,
      },
    });
  }

  /**
   * Spends tickets, refusing to go negative.
   *
   * Always inside a transaction, always after lockUser. The balance is read
   * *after* taking the lock — reading it before would defeat the lock entirely.
   */
  async debit(
    tx: Tx,
    params: {
      userId: string;
      amount: number;
      reason: TicketReason;
      raffleEntryId?: string;
      note?: string;
    },
  ) {
    if (params.amount <= 0) {
      throw new BadRequestException('Debit amount must be positive');
    }

    await this.lockUser(tx, params.userId);

    const balance = await this.getBalance(params.userId, tx);
    if (balance < params.amount) {
      throw new BadRequestException(
        `Not enough tickets: you have ${balance}, this costs ${params.amount}`,
      );
    }

    return tx.ticketLedger.create({
      data: {
        userId: params.userId,
        delta: -params.amount,
        reason: params.reason,
        raffleEntryId: params.raffleEntryId,
        note: params.note,
      },
    });
  }

  /** Paginated ledger for a "ticket history" view. */
  async getHistory(userId: string, { skip, take }: { skip: number; take: number }) {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.ticketLedger.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        include: {
          stake: { select: { id: true, duration: true, nft: { select: { tokenId: true, name: true } } } },
          raffleEntry: {
            select: { entryNumber: true, raffle: { select: { slug: true, title: true } } },
          },
        },
      }),
      this.prisma.ticketLedger.count({ where: { userId } }),
    ]);

    return { items, total };
  }
}
