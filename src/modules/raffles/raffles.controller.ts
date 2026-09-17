import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '@/common/decorators/public.decorator';
import { AuthenticatedUser, CurrentUser } from '@/common/decorators/current-user.decorator';
import { PaginationQueryDto, paginated } from '@/common/dto/pagination.dto';
import { AdminGuard } from '@/modules/auth/guards/admin.guard';
import { RafflesService } from './raffles.service';
import { CreateRaffleDto } from './dto/raffles.dto';

@ApiTags('raffles')
@Controller('raffles')
export class RafflesController {
  constructor(private readonly raffles: RafflesService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Raffles currently open for entries' })
  listOpen() {
    return this.raffles.listOpen();
  }

  @Public()
  @Get('history')
  @ApiOperation({ summary: 'Past draws — the RAFFLE HISTORY section' })
  async history(@Query() query: PaginationQueryDto) {
    const { items, total } = await this.raffles.listHistory({
      skip: query.skip,
      take: query.limit,
    });
    return paginated(items, total, query);
  }

  @Public()
  @Get('entries/recent')
  @ApiOperation({ summary: 'The TICKET STRIP — most recent entries across all raffles' })
  recentEntries() {
    return this.raffles.listRecentEntries();
  }

  @Public()
  @Get(':slug')
  @ApiOperation({ summary: 'A single raffle' })
  getOne(@Param('slug') slug: string) {
    return this.raffles.getBySlug(slug);
  }

  /**
   * Public on purpose. The point of commit-reveal is that anyone can audit a
   * result without our cooperation — putting this behind auth would undercut
   * the guarantee it exists to provide.
   */
  @Public()
  @Get(':slug/verify')
  @ApiOperation({ summary: 'Recompute a finished draw from its published inputs' })
  verify(@Param('slug') slug: string) {
    return this.raffles.verifyDraw(slug);
  }

  @Get(':slug/my-entries')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'The current wallet’s entries in this raffle' })
  myEntries(@CurrentUser() user: AuthenticatedUser, @Param('slug') slug: string) {
    return this.raffles.getMyEntries(user.id, slug);
  }

  @Post(':slug/enter')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Spend tickets to enter' })
  enter(@CurrentUser() user: AuthenticatedUser, @Param('slug') slug: string) {
    return this.raffles.enter(user.id, user.walletAddress, slug);
  }

  // --- Operator ------------------------------------------------------------

  @Post()
  @UseGuards(AdminGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a raffle (commits the draw seed)' })
  create(@Body() dto: CreateRaffleDto) {
    return this.raffles.create(dto);
  }

  @Post(':id/draw')
  // 200: the draw updates the raffle, it does not create a resource.
  @HttpCode(HttpStatus.OK)
  @UseGuards(AdminGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Run the draw and reveal the seed' })
  draw(@Param('id') id: string) {
    return this.raffles.runDraw(id);
  }
}
