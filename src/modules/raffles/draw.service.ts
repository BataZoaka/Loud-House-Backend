import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';

export interface DrawCommitment {
  serverSeed: string;
  serverSeedHash: string;
}

export interface DrawResult {
  winningIndex: number;
  drawHash: string;
}

/**
 * Provably fair raffle draws, by commit-reveal.
 *
 * The problem: these are off-chain draws for real 1/1 prizes. Holders have to
 * take our word that we did not look at the 1,204 entries and then pick the
 * team's own wallet. "Trust us" is not good enough, and it is not necessary —
 * a hash commitment costs nothing and removes the need for trust entirely.
 *
 * How it works:
 *
 *   1. When the raffle is CREATED, we generate a random `serverSeed` and
 *      publish only `sha256(serverSeed)`. Anyone can screenshot that hash
 *      before entries open.
 *   2. Entries come in. We cannot change the seed — the hash is already out
 *      there, and finding a different seed with the same hash means breaking
 *      SHA-256.
 *   3. After entries close, we mix in the hash of an Ethereum block mined
 *      AFTER the close. We could not have known it at commit time, which stops
 *      us grinding through candidate seeds in advance looking for one that
 *      lands on a wallet we like.
 *   4. We reveal the seed. Anyone can now recompute the winner by hand and
 *      confirm the revealed seed matches the hash published in step 1.
 *
 * Every input is stored on the Raffle row so the whole draw is reproducible by
 * a third party. If the numbers do not check out, holders will know.
 */
@Injectable()
export class DrawService {
  private readonly logger = new Logger(DrawService.name);

  /** Step 1: generate the seed and its public commitment. */
  createCommitment(): DrawCommitment {
    const serverSeed = randomBytes(32).toString('hex');
    return { serverSeed, serverSeedHash: this.hash(serverSeed) };
  }

  /**
   * Steps 3 and 4: derive the winning index from the revealed inputs.
   *
   * On modulo bias: taking a 256-bit number mod 1,204 is very slightly biased
   * towards low indices, because 2^256 is not an exact multiple of 1,204. The
   * size of that bias is about 1,204 / 2^256 — roughly one part in 10^74. It is
   * not measurable, not exploitable, and not worth the added complexity of
   * rejection sampling here. (It would matter if the hash were 32-bit.)
   */
  selectWinner(params: {
    serverSeed: string;
    raffleId: string;
    entryCount: number;
    entropyBlockHash?: string | null;
  }): DrawResult {
    const { serverSeed, raffleId, entryCount, entropyBlockHash } = params;

    if (entryCount <= 0) {
      throw new Error('Cannot draw a raffle with no entries');
    }

    // raffleId is in the preimage so two raffles that somehow shared a seed
    // would still draw independently.
    const preimage = [serverSeed, entropyBlockHash ?? 'no-block-entropy', raffleId].join(':');
    const drawHash = this.hash(preimage);

    const winningIndex = Number(BigInt(`0x${drawHash}`) % BigInt(entryCount));

    this.logger.log(`Raffle ${raffleId}: index ${winningIndex} of ${entryCount} (${drawHash})`);

    return { winningIndex, drawHash };
  }

  /**
   * Re-runs a published draw from its stored inputs. Wire this to a public
   * endpoint so sceptical holders can verify a result themselves rather than
   * being asked to believe it.
   */
  verify(params: {
    serverSeed: string;
    serverSeedHash: string;
    raffleId: string;
    entryCount: number;
    entropyBlockHash?: string | null;
    expectedDrawHash: string;
    expectedWinningIndex: number;
  }): { valid: boolean; reasons: string[] } {
    const reasons: string[] = [];

    if (this.hash(params.serverSeed) !== params.serverSeedHash) {
      reasons.push('Revealed seed does not match the hash committed before entries opened');
    }

    const { winningIndex, drawHash } = this.selectWinner(params);

    if (drawHash !== params.expectedDrawHash) {
      reasons.push('Recomputed draw hash does not match the published one');
    }
    if (winningIndex !== params.expectedWinningIndex) {
      reasons.push('Recomputed winning index does not match the published one');
    }

    return { valid: reasons.length === 0, reasons };
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }
}
