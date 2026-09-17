import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '@/common/decorators/public.decorator';
import { CollectionService } from './collection.service';
import { QueryNftsDto } from './dto/query-nfts.dto';

/** All public — the catalogue is browsable without connecting a wallet. */
@ApiTags('collection')
@Public()
@Controller('collection')
export class CollectionController {
  constructor(private readonly collection: CollectionService) {}

  @Get('nfts')
  @ApiOperation({ summary: 'Browse the catalogue with search, filters and sorting' })
  findAll(@Query() query: QueryNftsDto) {
    return this.collection.findAll(query);
  }

  @Get('traits')
  @ApiOperation({ summary: 'Trait values and counts for the filter dropdowns' })
  traits() {
    return this.collection.getTraitFilters();
  }

  @Get('stats')
  @ApiOperation({ summary: 'Supply, holders and staked counts' })
  stats() {
    return this.collection.getStats();
  }

  @Get('nfts/:tokenId')
  @ApiOperation({ summary: 'A single tenant with full traits' })
  findOne(@Param('tokenId', ParseIntPipe) tokenId: number) {
    return this.collection.findByTokenId(tokenId);
  }
}
