import { ConfigService } from '@nestjs/config';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { OwnershipService } from './ownership.service';

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterAll(() => jest.restoreAllMocks());

/**
 * These tests guard the rule from the designs: "HOLDERS WITH 1+ TICKET".
 *
 * The failure they exist to prevent is subtle and not caught by any happy-path
 * test: tickets are earned once and stay in the ledger forever, so a wallet
 * that stakes, collects tickets, then sells every tenant would keep entering
 * draws indefinitely unless holding is re-checked at the moment of entry.
 */
const makeConfig = (overrides: Record<string, unknown> = {}) => {
  const values: Record<string, unknown> = {
    demoMode: false,
    'chain.nftContractAddress': '0x00000000000000000000000000000000000000ff',
    'chain.chainId': 4663,
    'chain.rpcUrl': 'https://rpc.mainnet.chain.robinhood.com',
    ...overrides,
  };
  return {
    get: (key: string) => values[key],
    getOrThrow: (key: string) => {
      if (values[key] === undefined) throw new Error(`missing ${key}`);
      return values[key];
    },
  } as unknown as ConfigService;
};

describe('OwnershipService', () => {
  describe('chain configuration', () => {
    it('accepts Robinhood Chain', () => {
      expect(() => new OwnershipService(makeConfig({ 'chain.chainId': 4663 }))).not.toThrow();
    });

    it('accepts Robinhood Chain testnet', () => {
      expect(() => new OwnershipService(makeConfig({ 'chain.chainId': 46630 }))).not.toThrow();
    });

    /**
     * This used to silently fall back to Ethereum mainnet, which meant a typo
     * in CHAIN_ID pointed every ownership read at the wrong network and every
     * stake was refused with no clue why.
     */
    it('refuses to start on an unknown chain rather than guessing', () => {
      expect(() => new OwnershipService(makeConfig({ 'chain.chainId': 9999 }))).toThrow(
        /CHAIN_ID 9999 is not configured/,
      );
    });
  });

  describe('assertHoldsAny — the raffle entry gate', () => {
    it('lets a wallet holding tenants through', async () => {
      const service = new OwnershipService(makeConfig());
      jest.spyOn(service, 'balanceOf').mockResolvedValue(3);
      await expect(service.assertHoldsAny('0xabc')).resolves.toBe(true);
    });

    it('rejects a wallet that has sold every tenant', async () => {
      const service = new OwnershipService(makeConfig());
      jest.spyOn(service, 'balanceOf').mockResolvedValue(0);
      await expect(service.assertHoldsAny('0xabc')).resolves.toBe(false);
    });

    it('lets a wallet holding exactly one through', async () => {
      const service = new OwnershipService(makeConfig());
      jest.spyOn(service, 'balanceOf').mockResolvedValue(1);
      await expect(service.assertHoldsAny('0xabc')).resolves.toBe(true);
    });

    /**
     * Fail CLOSED. If the RPC is unreachable we reject the entry rather than
     * wave it through — an entry we cannot verify would burn a real ticket on
     * a draw for a real 1/1, and neither is easy to unwind.
     */
    it('throws rather than allowing an entry it cannot verify', async () => {
      const service = new OwnershipService(makeConfig());
      jest.spyOn(service, 'balanceOf').mockResolvedValue(null);
      await expect(service.assertHoldsAny('0xabc')).rejects.toThrow(ServiceUnavailableException);
    });

    it('throws when no RPC is configured at all', async () => {
      const service = new OwnershipService(makeConfig({ 'chain.rpcUrl': '' }));
      await expect(service.assertHoldsAny('0xabc')).rejects.toThrow(ServiceUnavailableException);
    });

    it('is bypassed in demo mode, matching "no wallet connected yet"', async () => {
      const service = new OwnershipService(makeConfig({ demoMode: true, 'chain.rpcUrl': '' }));
      await expect(service.assertHoldsAny('0xabc')).resolves.toBe(true);
    });
  });

  describe('assertOwns — the staking gate', () => {
    it('allows staking a tenant the wallet owns', async () => {
      const service = new OwnershipService(makeConfig());
      jest.spyOn(service, 'getOwnerOf').mockResolvedValue('0xabc');
      await expect(service.assertOwns('0xABC', 100)).resolves.toBe(true);
    });

    it('compares addresses case-insensitively', async () => {
      const service = new OwnershipService(makeConfig());
      jest.spyOn(service, 'getOwnerOf').mockResolvedValue('0xdeadbeef');
      await expect(service.assertOwns('0xDeAdBeEf', 100)).resolves.toBe(true);
    });

    it('refuses a tenant owned by someone else', async () => {
      const service = new OwnershipService(makeConfig());
      jest.spyOn(service, 'getOwnerOf').mockResolvedValue('0xsomeoneelse');
      await expect(service.assertOwns('0xabc', 100)).resolves.toBe(false);
    });

    it('throws rather than allowing a stake it cannot verify', async () => {
      const service = new OwnershipService(makeConfig());
      jest.spyOn(service, 'getOwnerOf').mockResolvedValue(null);
      await expect(service.assertOwns('0xabc', 100)).rejects.toThrow(ServiceUnavailableException);
    });
  });
});
