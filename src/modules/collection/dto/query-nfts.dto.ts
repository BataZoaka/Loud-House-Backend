import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '@/common/dto/pagination.dto';

export enum NftSort {
  TOKEN_ID_ASC = 'tokenId:asc',
  TOKEN_ID_DESC = 'tokenId:desc',
  RARITY_ASC = 'rarity:asc',
  RARITY_DESC = 'rarity:desc',
}

export class QueryNftsDto extends PaginationQueryDto {
  /** Matches the "SEARCH NFTS… #0001" box. Accepts a name or a token id. */
  @ApiPropertyOptional({ example: '#0001' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Transform(({ value }) => String(value).trim())
  search?: string;

  /** The "BACKGROUND: ALL NFTS" dropdown. */
  @ApiPropertyOptional({ example: 'Pink' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  background?: string;

  @ApiPropertyOptional({ enum: NftSort, default: NftSort.TOKEN_ID_ASC })
  @IsOptional()
  @IsEnum(NftSort)
  sort: NftSort = NftSort.TOKEN_ID_ASC;

  /** Restrict to one wallet's tenants. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Transform(({ value }) => String(value).toLowerCase())
  owner?: string;

  @ApiPropertyOptional({ description: 'Filter by a specific trait value.' })
  @IsOptional()
  @IsString()
  traitType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  traitValue?: string;

  @ApiPropertyOptional({ description: 'Only tenants with rank <= this.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  maxRarityRank?: number;
}
