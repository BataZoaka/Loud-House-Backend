import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Raffle, RaffleStatus, TicketReason } from '@prisma/client';
import { PrismaService } from '@/common/prisma/prisma.service';
import { TicketsService } from '@/modules/tickets/tickets.service';
import { OwnershipService } from '@/modules/chain/ownership.service';
import { DrawService } from './draw.service';
import { CreateRaffleDto } from './dto/raffles.dto';

@Injectable()
export class RafflesService {
  private readonly logger = new Logger(RafflesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tickets: TicketsService,
    private readonly draw: DrawService,
    private readonly ownership: OwnershipService,
  ) {}

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** Raffles currently accepting entries. */
  async listOpen() {
    const now = new Date();
    const raffles = await this.prisma.raffle.findMany({
      where: { status: RaffleStatus.OPEN, opensAt: { lte: now }, closesAt: { gt: now } },
      orderBy: { closesAt: 'asc' },
      include: { prizeNft: { select: { tokenId: true, name: true, imageUrl: true } } },
    });
    return raffles.map((raffle) => this.toPublicDto(raffle));
  }

  async getBySlug(slug: string) {
    const raffle = await this.prisma.raffle.findUnique({
      where: { slug },
      include: {
        prizeNft: { select: { tokenId: true, name: true, imageUrl: true } },
        winner: { select: { walletAddress: true, displayName: true } },
        winningEntry: { select: { entryNumber: true } },
      },
    });
    if (!raffle) throw new NotFoundException('Raffle not found');
    return this.toPublicDto(raffle);
  }

  /** "RAFFLE HISTORY" / "RECENT WINNERS" — everything already drawn. */
  async listHistory({ skip, take }: { skip: number; take: number }) {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.raffle.findMany({
        where: { status: RaffleStatus.DRAWN },
        orderBy: { drawnAt: 'desc' },
        skip,
        take,
        include: {
          prizeNft: { select: { tokenId: true, name: true, imageUrl: true } },
          winner: { select: { walletAddress: true, displayName: true } },
          winningEntry: { select: { entryNumber: true } },
        },
      }),
      this.prisma.raffle.count({ where: { status: RaffleStatus.DRAWN } }),
    ]);
    return { items: items.map((raffle) => this.toPublicDto(raffle)), total };
  }

  /**
   * The TICKET STRIP: the most recent entries across all raffles.
   *
   * Addresses are truncated here rather than in the frontend. Returning full
   * wallet addresses on a public endpoint hands anyone a scrape-ready list of
   * every participating holder; the UI only ever shows "0x71A…F6F anyway.
   */
  async listRecentEntries(limit = 5) {
    const entries = await this.prisma.raffleEntry.findMany({
      orderBy: { entryNumber: 'desc' },
      take: limit,
      include: { raffle: { select: { slug: true, title: true } } },
    });

    return entries.map((entry) => ({
      entryNumber: entry.entryNumber,
      ticketLabel: `TICKET #${String(entry.entryNumber).padStart(6, '0')}`,
      raffle: entry.raffle,
      wallet: this.truncateAddress(entry.walletAddress),
      createdAt: entry.createdAt,
    }));
  }

  /** How many entries the current user has in a given raffle. */
  async getMyEntries(userId: string, slug: string) {
    const raffle = await this.prisma.raffle.findUnique({ where: { slug }, select: { id: true } });
    if (!raffle) throw new NotFoundException('Raffle not found');

    const entries = await this.prisma.raffleEntry.findMany({
      where: { userId, raffleId: raffle.id },
      orderBy: { entryNumber: 'asc' },
      select: { entryNumber: true, createdAt: true },
    });

    return { count: entries.length, entries };
  }

  // -------------------------------------------------------------------------
  // Entering
  // -------------------------------------------------------------------------

  /**
   * Spend tickets to enter.
   *
   * Everything below happens in one transaction: the ticket debit, the entry
   * row, and the denormalised counter. If any part fails the user keeps their
   * ticket. Splitting these into separate writes is how you end up with
   * entries that were never paid for, or tickets burned for no entry.
   */
  async enter(userId: string, walletAddress: string, slug: string) {
    const raffle = await this.prisma.raffle.findUnique({ where: { slug } });
    if (!raffle) throw new NotFoundException('Raffle not found');

    const now = new Date();
    if (raffle.status !== RaffleStatus.OPEN) {
      throw new BadRequestException('This raffle is not open for entries');
    }
    if (raffle.opensAt > now) {
      throw new BadRequestException('This raffle has not opened yet');
    }
    if (raffle.closesAt <= now) {
      throw new BadRequestException('This raffle has closed');
    }

    // The holder half of "HOLDERS WITH 1+ TICKET". Deliberately checked BEFORE
    // opening the transaction: it is a network round-trip to the RPC, and
    // holding the raffle row lock (which serialises every entry to this raffle)
    // across a call that can take hundreds of milliseconds would throttle the
    // whole raffle to the speed of our RPC provider.
    //
    // Tickets alone would not be enough here. They are earned once and stay in
    // the ledger, so a wallet that staked, collected, then sold every tenant
    // would otherwise keep entering draws forever.
    if (raffle.holdersOnly) {
      const holdsAny = await this.ownership.assertHoldsAny(walletAddress);
      if (!holdsAny) {
        throw new ForbiddenException(
          'You need to hold at least one tenant to enter. Tickets earned earlier do not count once the tenants are sold.',
        );
      }
    }

    return this.prisma.$transaction(async (tx) => {
      // Take the raffle row lock FIRST, before touching anything else.
      //
      // This is not optional bookkeeping — without it this transaction
      // deadlocks under concurrency, and it took a real deadlock (Postgres
      // 40P01) to find it:
      //
      //   Inserting a raffle_entries row takes a FOR KEY SHARE lock on its
      //   parent raffles row, because of the foreign key. The `UPDATE raffles
      //   SET entryCount` at the end then wants FOR UPDATE on that same row.
      //   Two simultaneous entries each hold the share lock and each wait for
      //   the other to release it. Neither can proceed.
      //
      // Acquiring the strongest lock up front removes the cycle: the second
      // transaction simply waits here until the first commits. Entries to one
      // raffle are serialised, which is cheap (the transaction is a few
      // milliseconds) and is what we want anyway, since entryNumber ordering
      // decides the draw.
      //
      // The general rule this is an instance of: when several transactions
      // touch the same rows, they must take locks in the SAME ORDER. Every
      // deadlock is a violation of that.
      await tx.$queryRaw`SELECT id FROM raffles WHERE id = ${raffle.id} FOR UPDATE`;

      if (raffle.maxEntriesPerUser !== null) {
        const existing = await tx.raffleEntry.count({ where: { userId, raffleId: raffle.id } });
        if (existing >= raffle.maxEntriesPerUser) {
          throw new ConflictException(
            `Entry limit reached (${raffle.maxEntriesPerUser} per wallet)`,
          );
        }
      }

      // Eligibility as shown on the card: "HOLDERS WITH 1+ TICKET".
      const balance = await this.tickets.getBalance(userId, tx);
      if (balance < raffle.minTicketsToEnter) {
        throw new BadRequestException(
          `You need at least ${raffle.minTicketsToEnter} ticket(s) to enter`,
        );
      }

      const entry = await tx.raffleEntry.create({
        data: { raffleId: raffle.id, userId, walletAddress: walletAddress.toLowerCase() },
      });

      // debit() takes a row lock on the user and re-reads the balance inside
      // this transaction, so a double-clicked "ENTER RAFFLE" cannot spend the
      // same ticket twice. See TicketsService.lockUser for why.
      await this.tickets.debit(tx, {
        userId,
        amount: raffle.entryCost,
        reason: TicketReason.RAFFLE_ENTRY,
        raffleEntryId: entry.id,
        note: `Entry #${entry.entryNumber} — ${raffle.title}`,
      });

      await tx.raffle.update({
        where: { id: raffle.id },
        data: { entryCount: { increment: 1 } },
      });

      return {
        entryNumber: entry.entryNumber,
        ticketLabel: `TICKET #${String(entry.entryNumber).padStart(6, '0')}`,
        raffleSlug: raffle.slug,
        ticketBalance: await this.tickets.getBalance(userId, tx),
      };
    });
  }

  // -------------------------------------------------------------------------
  // Operator actions
  // -------------------------------------------------------------------------

  /** Create a raffle and commit to its seed in the same breath. */
  async create(dto: CreateRaffleDto) {
    const opensAt = new Date(dto.opensAt);
    const closesAt = new Date(dto.closesAt);
    if (closesAt <= opensAt) {
      throw new BadRequestException('closesAt must be after opensAt');
    }

    let prizeNftId: string | undefined;
    if (dto.prizeTokenId !== undefined) {
      const nft = await this.prisma.nft.findUnique({
        where: { tokenId: dto.prizeTokenId },
        select: { id: true },
      });
      if (!nft) throw new NotFoundException(`Tenant #${dto.prizeTokenId} not found`);
      prizeNftId = nft.id;
    }

    // The commitment is generated at creation, BEFORE a single entry exists.
    // That ordering is the entire guarantee — see DrawService.
    const { serverSeed, serverSeedHash } = this.draw.createCommitment();

    const raffle = await this.prisma.raffle.create({
      data: {
        slug: dto.slug,
        title: dto.title,
        subtitle: dto.subtitle,
        description: dto.description,
        prizeNftId,
        entryCost: dto.entryCost ?? 1,
        minTicketsToEnter: dto.minTicketsToEnter ?? 1,
        holdersOnly: dto.holdersOnly ?? true,
        maxEntriesPerUser: dto.maxEntriesPerUser,
        opensAt,
        closesAt,
        serverSeed,
        serverSeedHash,
        status: opensAt <= new Date() ? RaffleStatus.OPEN : RaffleStatus.SCHEDULED,
      },
    });

    return this.toPublicDto(raffle);
  }

  /**
   * Run the draw. Only valid once entries have closed.
   *
   * Note the ordering: we fetch block entropy AFTER closing, pick the winner,
   * and only then reveal the seed by setting drawnAt. A draw that revealed the
   * seed while entries were still open would let a late entrant compute
   * exactly which entry number wins and buy it.
   */
  async runDraw(raffleId: string) {
    const raffle = await this.prisma.raffle.findUnique({ where: { id: raffleId } });
    if (!raffle) throw new NotFoundException('Raffle not found');
    if (raffle.status === RaffleStatus.DRAWN) {
      throw new ConflictException('This raffle has already been drawn');
    }
    if (raffle.closesAt > new Date()) {
      throw new BadRequestException('Cannot draw before entries close');
    }
    if (raffle.entryCount === 0) {
      throw new BadRequestException('No entries to draw from');
    }

    const block = await this.ownership.getLatestBlock();

    const { winningIndex, drawHash } = this.draw.selectWinner({
      serverSeed: raffle.serverSeed!,
      raffleId: raffle.id,
      entryCount: raffle.entryCount,
      entropyBlockHash: block?.hash,
    });

    // Ordered by entryNumber so the index maps to a stable, publicly visible
    // position. Ordering by createdAt would be ambiguous for entries sharing a
    // timestamp, and the resulting draw would not be reproducible.
    const winningEntry = await this.prisma.raffleEntry.findFirst({
      where: { raffleId: raffle.id },
      orderBy: { entryNumber: 'asc' },
      skip: winningIndex,
    });

    if (!winningEntry) {
      throw new BadRequestException('Entry count and stored entries disagree — aborting draw');
    }

    const drawn = await this.prisma.raffle.update({
      where: { id: raffle.id },
      data: {
        status: RaffleStatus.DRAWN,
        drawnAt: new Date(),
        drawHash,
        entropyBlockNumber: block?.number,
        entropyBlockHash: block?.hash,
        winningEntryId: winningEntry.id,
        winnerUserId: winningEntry.userId,
      },
      include: {
        prizeNft: { select: { tokenId: true, name: true, imageUrl: true } },
        winner: { select: { walletAddress: true, displayName: true } },
        winningEntry: { select: { entryNumber: true } },
      },
    });

    this.logger.log(`Raffle ${raffle.slug} drawn: entry #${winningEntry.entryNumber}`);
    return this.toPublicDto(drawn);
  }

  /** Public verification of a finished draw. */
  async verifyDraw(slug: string) {
    const raffle = await this.prisma.raffle.findUnique({ where: { slug } });
    if (!raffle) throw new NotFoundException('Raffle not found');
    if (raffle.status !== RaffleStatus.DRAWN || !raffle.serverSeed) {
      throw new BadRequestException('This raffle has not been drawn yet');
    }

    const winningEntry = await this.prisma.raffleEntry.findUnique({
      where: { id: raffle.winningEntryId! },
      select: { entryNumber: true },
    });

    const allEntries = await this.prisma.raffleEntry.findMany({
      where: { raffleId: raffle.id },
      orderBy: { entryNumber: 'asc' },
      select: { entryNumber: true },
    });
    const expectedWinningIndex = allEntries.findIndex(
      (entry) => entry.entryNumber === winningEntry?.entryNumber,
    );

    const result = this.draw.verify({
      serverSeed: raffle.serverSeed,
      serverSeedHash: raffle.serverSeedHash,
      raffleId: raffle.id,
      entryCount: raffle.entryCount,
      entropyBlockHash: raffle.entropyBlockHash,
      expectedDrawHash: raffle.drawHash!,
      expectedWinningIndex,
    });

    return {
      ...result,
      // Everything a third party needs to redo this by hand.
      inputs: {
        serverSeed: raffle.serverSeed,
        serverSeedHash: raffle.serverSeedHash,
        raffleId: raffle.id,
        entryCount: raffle.entryCount,
        entropyBlockNumber: raffle.entropyBlockNumber?.toString() ?? null,
        entropyBlockHash: raffle.entropyBlockHash,
        drawHash: raffle.drawHash,
        winningIndex: expectedWinningIndex,
        winningEntryNumber: winningEntry?.entryNumber,
      },
      howToVerify: [
        'sha256(serverSeed) must equal serverSeedHash, which was published when the raffle was created.',
        'drawHash = sha256(`${serverSeed}:${entropyBlockHash}:${raffleId}`).',
        'winningIndex = BigInt(0x + drawHash) % entryCount.',
        'The winner is the entry at that index when entries are sorted by entryNumber ascending.',
      ],
    };
  }

  // -------------------------------------------------------------------------
  // Serialisation
  // -------------------------------------------------------------------------

  /**
   * Shapes a raffle for public consumption.
   *
   * The critical line is the serverSeed one. Leaking the seed before the draw
   * would let anyone compute the winning index in advance and enter until they
   * own it — so it is withheld until drawnAt is set. This is exactly why the
   * whole object is mapped by hand instead of being returned straight from
   * Prisma: a `select` you forget to narrow ships the secret.
   */
  private toPublicDto(raffle: Raffle & Record<string, unknown>) {
    const now = Date.now();
    const isDrawn = raffle.status === RaffleStatus.DRAWN;

    return {
      id: raffle.id,
      slug: raffle.slug,
      title: raffle.title,
      subtitle: raffle.subtitle,
      description: raffle.description,
      status: raffle.status,
      prize: raffle.prizeNft ?? { label: raffle.prizeLabel, imageUrl: raffle.prizeImageUrl },
      entryCost: raffle.entryCost,
      minTicketsToEnter: raffle.minTicketsToEnter,
      holdersOnly: raffle.holdersOnly,
      eligibilityLabel: raffle.holdersOnly
        ? `HOLDERS WITH ${raffle.minTicketsToEnter}+ TICKET`
        : `${raffle.minTicketsToEnter}+ TICKET`,
      maxEntriesPerUser: raffle.maxEntriesPerUser,
      entryCount: raffle.entryCount,
      opensAt: raffle.opensAt,
      closesAt: raffle.closesAt,
      drawnAt: raffle.drawnAt,
      timeRemainingMs: Math.max(0, raffle.closesAt.getTime() - now),
      winner: raffle.winner
        ? {
            wallet: this.truncateAddress((raffle.winner as { walletAddress: string }).walletAddress),
            displayName: (raffle.winner as { displayName: string | null }).displayName,
            entryNumber: (raffle.winningEntry as { entryNumber: number } | null)?.entryNumber,
          }
        : null,
      fairness: {
        // Always public: this is the commitment holders check against later.
        serverSeedHash: raffle.serverSeedHash,
        // Revealed only after the draw. Never before.
        serverSeed: isDrawn ? raffle.serverSeed : null,
        drawHash: isDrawn ? raffle.drawHash : null,
        entropyBlockNumber: isDrawn ? (raffle.entropyBlockNumber?.toString() ?? null) : null,
        entropyBlockHash: isDrawn ? raffle.entropyBlockHash : null,
      },
    };
  }

  private truncateAddress(address: string): string {
    return `${address.slice(0, 5)}…${address.slice(-3)}`.toUpperCase();
  }
}
