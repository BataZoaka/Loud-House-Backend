import { Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DrawService } from './draw.service';

// The service logs every draw, which is useful in production and 2,000 lines
// of noise in the distribution test. Silence it here only.
beforeAll(() => jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined));
afterAll(() => jest.restoreAllMocks());

/**
 * DrawService is pure — same inputs, same winner, no database, no clock. That
 * is not an accident; it is why the draw can be tested properly and why a
 * holder can recompute a result by hand. Keep it that way.
 */
describe('DrawService', () => {
  let service: DrawService;

  beforeEach(() => {
    service = new DrawService();
  });

  describe('createCommitment', () => {
    it('publishes a hash that matches the seed it is hiding', () => {
      const { serverSeed, serverSeedHash } = service.createCommitment();
      const expected = createHash('sha256').update(serverSeed).digest('hex');
      expect(serverSeedHash).toBe(expected);
    });

    it('never repeats a seed', () => {
      const seeds = new Set(
        Array.from({ length: 200 }, () => service.createCommitment().serverSeed),
      );
      expect(seeds.size).toBe(200);
    });
  });

  describe('selectWinner', () => {
    const base = {
      serverSeed: 'a'.repeat(64),
      raffleId: 'raffle_test_1',
      entryCount: 1204,
      entropyBlockHash: '0xdeadbeef',
    };

    it('always lands inside the entry range', () => {
      const { winningIndex } = service.selectWinner(base);
      expect(winningIndex).toBeGreaterThanOrEqual(0);
      expect(winningIndex).toBeLessThan(base.entryCount);
    });

    it('is deterministic — the whole point of publishing the inputs', () => {
      const first = service.selectWinner(base);
      const second = service.selectWinner(base);
      expect(second).toEqual(first);
    });

    it('changes when the block entropy changes', () => {
      const a = service.selectWinner(base);
      const b = service.selectWinner({ ...base, entropyBlockHash: '0xfeedface' });
      expect(b.drawHash).not.toBe(a.drawHash);
    });

    it('draws independently for two raffles sharing a seed', () => {
      const a = service.selectWinner(base);
      const b = service.selectWinner({ ...base, raffleId: 'raffle_test_2' });
      expect(b.drawHash).not.toBe(a.drawHash);
    });

    it('handles a single-entry raffle', () => {
      const { winningIndex } = service.selectWinner({ ...base, entryCount: 1 });
      expect(winningIndex).toBe(0);
    });

    it('refuses to draw with no entries', () => {
      expect(() => service.selectWinner({ ...base, entryCount: 0 })).toThrow();
    });

    /**
     * Not a randomness proof — SHA-256 is not on trial here. This catches the
     * kind of bug that actually happens: an off-by-one in the modulo, or a
     * preimage that collapses so every raffle lands on the same index.
     */
    it('spreads across the range over many seeds', () => {
      const buckets = new Array(10).fill(0);
      for (let i = 0; i < 2000; i++) {
        const { winningIndex } = service.selectWinner({
          ...base,
          serverSeed: createHash('sha256').update(String(i)).digest('hex'),
          entryCount: 10,
        });
        buckets[winningIndex]++;
      }
      // Expect ~200 per bucket. A generous band still catches a stuck index.
      for (const count of buckets) {
        expect(count).toBeGreaterThan(120);
        expect(count).toBeLessThan(280);
      }
    });
  });

  describe('verify', () => {
    const raffleId = 'raffle_verify_1';
    const entryCount = 500;
    const entropyBlockHash = '0xabc123';

    it('accepts an honest draw', () => {
      const { serverSeed, serverSeedHash } = service.createCommitment();
      const { winningIndex, drawHash } = service.selectWinner({
        serverSeed,
        raffleId,
        entryCount,
        entropyBlockHash,
      });

      const result = service.verify({
        serverSeed,
        serverSeedHash,
        raffleId,
        entryCount,
        entropyBlockHash,
        expectedDrawHash: drawHash,
        expectedWinningIndex: winningIndex,
      });

      expect(result.valid).toBe(true);
      expect(result.reasons).toHaveLength(0);
    });

    /**
     * The attack the commitment exists to stop: the operator sees the entries,
     * decides who should win, and reveals a different seed that produces them.
     * It fails because the revealed seed no longer hashes to what was published.
     */
    it('catches a swapped seed', () => {
      const honest = service.createCommitment();
      const swapped = service.createCommitment();

      const { winningIndex, drawHash } = service.selectWinner({
        serverSeed: swapped.serverSeed,
        raffleId,
        entryCount,
        entropyBlockHash,
      });

      const result = service.verify({
        serverSeed: swapped.serverSeed,
        serverSeedHash: honest.serverSeedHash, // what was committed publicly
        raffleId,
        entryCount,
        entropyBlockHash,
        expectedDrawHash: drawHash,
        expectedWinningIndex: winningIndex,
      });

      expect(result.valid).toBe(false);
      expect(result.reasons[0]).toContain('does not match the hash committed');
    });

    it('catches a tampered winning index', () => {
      const { serverSeed, serverSeedHash } = service.createCommitment();
      const { winningIndex, drawHash } = service.selectWinner({
        serverSeed,
        raffleId,
        entryCount,
        entropyBlockHash,
      });

      const result = service.verify({
        serverSeed,
        serverSeedHash,
        raffleId,
        entryCount,
        entropyBlockHash,
        expectedDrawHash: drawHash,
        expectedWinningIndex: (winningIndex + 1) % entryCount,
      });

      expect(result.valid).toBe(false);
      expect(result.reasons).toContain(
        'Recomputed winning index does not match the published one',
      );
    });
  });
});
