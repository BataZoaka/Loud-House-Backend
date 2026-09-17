import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '@/common/decorators/public.decorator';
import { AuthenticatedUser, CurrentUser } from '@/common/decorators/current-user.decorator';
import { StakingService } from './staking.service';
import { CreateStakeDto } from './dto/staking.dto';

@ApiTags('staking')
@Controller('staking')
export class StakingController {
  constructor(private readonly staking: StakingService) {}

  /** Public: the tier cards render before anyone connects a wallet. */
  @Public()
  @Get('tiers')
  @ApiOperation({ summary: 'The five lock durations and their ticket rewards' })
  getTiers() {
    return this.staking.getTiers();
  }

  @Get('vault')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Everything the Stake page needs for the current wallet' })
  getVault(@CurrentUser() user: AuthenticatedUser) {
    return this.staking.getVault(user.id, user.walletAddress);
  }

  @Post('stake')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Lock a tenant in the vault' })
  stake(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateStakeDto) {
    return this.staking.stake(user.id, user.walletAddress, dto);
  }

  /**
   * Note there is no `userId` in the path or body — the acting user comes from
   * the token. An endpoint like POST /staking/:userId/unstake/:id would let
   * anyone drain anyone else's vault by editing a URL.
   */
  @Post('unstake/:stakeId')
  // 200, not Nest's default 201: withdrawing creates no new resource.
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Withdraw a matured lock and collect its tickets' })
  unstake(@CurrentUser() user: AuthenticatedUser, @Param('stakeId') stakeId: string) {
    return this.staking.unstake(user.id, user.walletAddress, stakeId);
  }
}
