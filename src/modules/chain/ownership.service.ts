import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Chain, PublicClient, createPublicClient, http, parseAbi } from 'viem';
import { arbitrum, base, mainnet, polygon, sepolia } from 'viem/chains';

/** The two ERC-721 reads we need. No need for the full ABI. */
const ERC721_ABI = parseAbi([
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function balanceOf(address owner) view returns (uint256)',
]);

const CHAINS: Record<number, Chain> = {
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

    if (!rpcUrl) {
      // Not fatal in demo mode, but we log loudly so it is obvious in the
      // boot output why ownership checks are not happening.
      this.logger.warn('RPC_URL is not set — on-chain ownership checks are disabled');
      this.client = null;
      return;
    }

    this.client = createPublicClient({
      chain: CHAINS[chainId] ?? mainnet,
      transport: http(rpcUrl),
    });
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
