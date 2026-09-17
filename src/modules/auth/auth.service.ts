import { ForbiddenException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'node:crypto';
import { SiweMessage, generateNonce } from 'siwe';
import { PrismaService } from '@/common/prisma/prisma.service';
import { SessionDto } from './dto/auth.dto';

/** How long a freshly issued nonce stays usable. */
const NONCE_TTL_MS = 10 * 60 * 1000;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Step 1 of Sign-In-With-Ethereum.
   *
   * The wallet asks for a nonce, we mint one and remember it against the
   * address. The nonce is what makes the signature single-use: without it, a
   * signature captured once could be replayed to log in forever.
   *
   * Creating the user row here is deliberate — it costs one insert and means
   * an address always has somewhere to hang a nonce. The row carries no
   * privileges until a signature actually verifies.
   */
  async issueNonce(address: string): Promise<{ nonce: string; expiresAt: Date }> {
    const walletAddress = address.toLowerCase();
    const nonce = generateNonce();
    const nonceExpiresAt = new Date(Date.now() + NONCE_TTL_MS);

    await this.prisma.user.upsert({
      where: { walletAddress },
      create: { walletAddress, nonce, nonceExpiresAt },
      update: { nonce, nonceExpiresAt },
    });

    return { nonce, expiresAt: nonceExpiresAt };
  }

  /**
   * Step 2: the wallet returns the signed message. If it checks out, we hand
   * back a JWT.
   *
   * Four things must all hold, and skipping any one of them breaks the login:
   *
   *   1. The signature is cryptographically valid for the message. (siwe)
   *   2. The message's `domain` is OURS. Otherwise a phishing site can get a
   *      user to sign for evil.com and replay that signature here.
   *   3. The message's `nonce` is the one WE issued and has not expired.
   *   4. The nonce has not been used before — guaranteed by rotating it below.
   */
  async verifySignature(message: string, signature: string): Promise<SessionDto> {
    let siwe: SiweMessage;
    try {
      siwe = new SiweMessage(message);
    } catch {
      throw new UnauthorizedException('Malformed sign-in message');
    }

    const walletAddress = siwe.address.toLowerCase();

    const user = await this.prisma.user.findUnique({ where: { walletAddress } });
    if (!user) {
      throw new UnauthorizedException('Request a nonce before signing in');
    }
    if (user.isBanned) {
      throw new ForbiddenException('This wallet is not permitted to sign in');
    }
    if (!user.nonceExpiresAt || user.nonceExpiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('Nonce expired — request a new one');
    }

    try {
      await siwe.verify({
        signature,
        // siwe checks these for us and throws if the message disagrees.
        domain: this.config.getOrThrow<string>('siwe.domain'),
        nonce: user.nonce,
      });
    } catch (error) {
      this.logger.warn(`Failed SIWE verification for ${walletAddress}: ${String(error)}`);
      throw new UnauthorizedException('Signature verification failed');
    }

    // Burn the nonce whether or not anything else goes wrong from here. One
    // signature, one login.
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        nonce: generateNonce(),
        nonceExpiresAt: null,
        lastLoginAt: new Date(),
      },
    });

    return {
      accessToken: await this.jwt.signAsync({
        sub: updated.id,
        address: updated.walletAddress,
        isAdmin: updated.isAdmin,
      }),
      user: {
        id: updated.id,
        walletAddress: updated.walletAddress,
        displayName: updated.displayName,
        isAdmin: updated.isAdmin,
      },
    };
  }

  /**
   * Builds the exact EIP-4361 string the frontend should ask the wallet to
   * sign. Generating it server-side keeps the domain/uri/nonce consistent with
   * what verification will demand — a frontend assembling this by hand is a
   * reliable source of "signature verification failed" bugs.
   */
  buildSignInMessage(address: string, nonce: string): string {
    return new SiweMessage({
      domain: this.config.getOrThrow<string>('siwe.domain'),
      address, // checksummed, not lowercased — EIP-4361 requires EIP-55 here
      statement: this.config.getOrThrow<string>('siwe.statement'),
      uri: this.config.getOrThrow<string>('siwe.uri'),
      version: '1',
      chainId: this.config.getOrThrow<number>('chain.chainId'),
      nonce,
      issuedAt: new Date().toISOString(),
    }).prepareMessage();
  }

  async findById(id: string) {
    return this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        walletAddress: true,
        displayName: true,
        avatarUrl: true,
        isAdmin: true,
        isBanned: true,
        createdAt: true,
      },
    });
  }
}
