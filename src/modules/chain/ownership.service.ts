import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Chain, PublicClient, createPublicClient, http, parseAbi } from 'viem';
import {
  arbitrum,
  base,
  mainnet,
  polygon,
  robinhood,
  robinhoodTestnet,
  sepolia,
} from 'viem/chains';

/** The two ERC-721 reads we need. No need for the full ABI. */
const ERC721_ABI = parseAbi([
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function balanceOf(address owner) view returns (uint256)',
]);

/**
 * Chains this backend can talk to. The Loud House runs on Robinhood Chain
 * (4663) — an EVM L2, so the ERC-721 reads below are identical to Ethereum's;
 * only the chain config and RPC differ.
 */
const CHAINS: Record<number, Chain> = {
  4663: robinhood,
  46630: robinhoodTestnet,
  1: mainnet,
  137: polygon,
  8453: base,
  42161: arbitrum,
  11155111: sepolia,
};

/**
 * The single place that answers "does this wallet actually own this tenant?".
 *
 * This matters more here than in most apps. Staking is off-chain, so the only
 * thing standing between a user and infinite tickets is this check — without
 * it, anyone can POST a stake for tenant #0001 and farm rewards on an NFT they
 * have never owned.
 */
@Injectable()
export class OwnershipService {
  private readonly logger = new Logger(OwnershipService.name);
  private readonly client: PublicClient | null;
  private readonly contractAddress: `0x${string}`;
  private readonly demoMode: boolean;

  constructor(private readonly config: ConfigService) {
    this.demoMode = this.config.getOrThrow<boolean>('demoMode');
    this.contractAddress = this.config.getOrThrow<string>(
      'chain.nftContractAddress',
    ) as `0x${string}`;

    const chainId = this.config.getOrThrow<number>('chain.chainId');
    const rpcUrl = this.config.get<string>('chain.rpcUrl');

    // Validate the chain BEFORE the RPC early-return below, so a bad CHAIN_ID
    // is caught at boot even while running without an RPC. Otherwise the typo
    // hides until the day someone sets RPC_URL and turns demo mode off.
    const chain = CHAINS[chainId];
    if (!chain) {
      // Deliberately fatal. This used to fall back to Ethereum mainnet, which
      // is the worst possible behaviour: a typo in CHAIN_ID would point
      // ownership checks at the wrong network entirely, ownerOf() would revert
      // or return a stranger's address for every token, and every stake would
      // be refused with "you do not own this tenant" — with nothing in the
      // logs to explain why. Failing at boot costs seconds; failing silently
      // costs a day of debugging.
      throw new Error(
        `CHAIN_ID ${chainId} is not configured. Known chains: ${Object.keys(CHAINS).join(', ')}. ` +
          `Add it to CHAINS in ownership.service.ts if this is intentional.`,
      );
    }

    if (!rpcUrl) {
      // Not fatal in demo mode, but logged loudly so it is obvious from the
      // boot output why ownership checks are not happening.
      this.logger.warn('RPC_URL is not set — on-chain ownership checks are disabled');
      this.client = null;
      return;
    }

    this.client = createPublicClient({
      chain,
      transport: http(rpcUrl),
    });

    this.logger.log(`Chain: ${chain.name} (${chain.id})`);
  }

  /**
   * Reads ownerOf(tokenId) from the contract.
   *
   * Returns the lowercased owner, or null if the token does not exist — an
   * unminted token id makes ownerOf revert, which viem surfaces as a thrown
   * error rather than a null return.
   */
  async getOwnerOf(tokenId: number): Promise<string | null> {
    if (!this.client) return null;

    try {
      const owner = await this.client.readContract({
        address: this.contractAddress,
        abi: ERC721_ABI,
        functionName: 'ownerOf',
        args: [BigInt(tokenId)],
      });
      return (owner as string).toLowerCase();
    } catch (error) {
      this.logger.debug(`ownerOf(${tokenId}) failed: ${String(error)}`);
      return null;
    }
  }

  /**
   * Asserts that `walletAddress` owns `tokenId` right now.
   *
   * Three outcomes, and the difference between them is the whole point:
   *
   *   - Demo mode on  → allow. The designs say no wallet is connected yet.
   *   - Owner matches → allow.
   *   - RPC unreachable → THROW 503. We deliberately do not fail open here.
   *     If the node is down we would rather reject a legitimate stake than
   *     credit an illegitimate one, because tickets, once minted, are spent on
   *     real 1/1 prizes and cannot be clawed back cleanly.
   */
  async assertOwns(walletAddress: string, tokenId: number): Promise<boolean> {
    if (this.demoMode) {
      this.logger.debug(`DEMO_MODE: skipping ownership check for #${tokenId}`);
      return true;
    }

    if (!this.client) {
      throw new ServiceUnavailableException(
        'Ownership verification is unavailable — RPC_URL is not configured',
      );
    }

    const owner = await this.getOwnerOf(tokenId);
    if (owner === null) {
      throw new ServiceUnavailableException(
        'Could not verify ownership on-chain. Please try again shortly.',
      );
    }

    return owner === walletAddress.toLowerCase();
  }

  /**
   * Asserts the wallet currently holds at least one tenant.
   *
   * This is the gate on raffle entry. Tickets alone are not enough: they are
   * earned once and then sit in the ledger forever, so without this check a
   * wallet could stake, collect tickets, sell every tenant it owns, and keep
   * entering draws indefinitely. The designs say "HOLDERS WITH 1+ TICKET" —
   * holder AND tickets, both checked at the moment of entry.
   *
   * Staking does not move the NFT (there is no contract transaction), so a
   * staked tenant still counts toward balanceOf. Locking a tenant therefore
   * never costs a holder their eligibility.
   *
   * Fails closed, like assertOwns: if we cannot reach the chain we reject the
   * entry rather than let an unverified one through and burn a ticket on it.
   */
  async assertHoldsAny(walletAddress: string): Promise<boolean> {
    if (this.demoMode) {
      this.logger.debug(`DEMO_MODE: skipping holder check for ${walletAddress}`);
      return true;
    }

    if (!this.client) {
      throw new ServiceUnavailableException(
        'Holder verification is unavailable — RPC_URL is not configured',
      );
    }

    const balance = await this.balanceOf(walletAddress);
    if (balance === null) {
      throw new ServiceUnavailableException(
        'Could not verify your tenants on-chain. Please try again shortly.',
      );
    }

    return balance > 0;
  }

  /** How many tenants a wallet holds, straight from the contract. */
  async balanceOf(walletAddress: string): Promise<number | null> {
    if (!this.client) return null;
    try {
      const balance = await this.client.readContract({
        address: this.contractAddress,
        abi: ERC721_ABI,
        functionName: 'balanceOf',
        args: [walletAddress as `0x${string}`],
      });
      return Number(balance as bigint);
    } catch (error) {
      this.logger.debug(`balanceOf(${walletAddress}) failed: ${String(error)}`);
      return null;
    }
  }

  /** Latest block — used as extra draw entropy in the raffle service. */
  async getLatestBlock(): Promise<{ number: bigint; hash: string } | null> {
    if (!this.client) return null;
    try {
      const block = await this.client.getBlock({ blockTag: 'latest' });
      return { number: block.number, hash: block.hash };
    } catch (error) {
      this.logger.debug(`getBlock failed: ${String(error)}`);
      return null;
    }
  }
}
