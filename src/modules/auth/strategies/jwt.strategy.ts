import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '@/common/prisma/prisma.service';
import { AuthenticatedUser } from '@/common/decorators/current-user.decorator';

interface JwtPayload {
  sub: string;
  address: string;
  isAdmin: boolean;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('jwt.secret'),
    });
  }

  /**
   * Runs on every authenticated request once the token's signature checks out.
   *
   * We re-read the user from the database rather than trusting the token's
   * claims wholesale. A JWT is a snapshot from whenever it was issued — if you
   * ban a wallet or revoke admin, a token minted before that change still
   * carries the old claims for up to JWT_EXPIRES_IN. This lookup is the
   * difference between a ban taking effect now and taking effect in a week.
   */
  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, walletAddress: true, isAdmin: true, isBanned: true },
    });

    if (!user || user.isBanned) {
      throw new UnauthorizedException();
    }

    return { id: user.id, walletAddress: user.walletAddress, isAdmin: user.isAdmin };
  }
}
