import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { getAddress } from 'viem';
import { Public } from '@/common/decorators/public.decorator';
import { AuthenticatedUser, CurrentUser } from '@/common/decorators/current-user.decorator';
import { AuthService } from './auth.service';
import { NonceRequestDto, SessionDto, VerifySignatureDto } from './dto/auth.dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /**
   * GET /auth/nonce?address=0x...
   *
   * Returns both the nonce and the exact message to sign. The frontend passes
   * `message` straight to `signMessage` and sends the result to /auth/verify —
   * it never has to assemble the EIP-4361 string itself.
   */
  @Public()
  @Get('nonce')
  @ApiOperation({ summary: 'Start wallet sign-in: get a nonce and the message to sign' })
  async nonce(@Query() query: NonceRequestDto) {
    const { nonce, expiresAt } = await this.auth.issueNonce(query.address);
    // EIP-4361 requires the address in EIP-55 checksum form inside the message,
    // even though we store and compare it lowercased.
    const message = this.auth.buildSignInMessage(getAddress(query.address), nonce);
    return { nonce, message, expiresAt };
  }

  /** POST /auth/verify — exchange a signed message for a JWT. */
  @Public()
  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Finish wallet sign-in: verify the signature, receive a token' })
  @ApiOkResponse({ type: SessionDto })
  async verify(@Body() dto: VerifySignatureDto): Promise<SessionDto> {
    return this.auth.verifySignature(dto.message, dto.signature);
  }

  /** GET /auth/me — who the current token belongs to. */
  @Get('me')
  @ApiOperation({ summary: 'Current session' })
  async me(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.findById(user.id);
  }
}
