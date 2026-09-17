import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateRaffleDto {
  @ApiProperty({ example: 'tenant-0103-camo-stalk' })
  @IsString()
  @MaxLength(120)
  slug!: string;

  @ApiProperty({ example: 'TENANT #0103 — 1/1 CAMO STALK' })
  @IsString()
  @MaxLength(200)
  title!: string;

  @ApiPropertyOptional({ example: 'THE LOUD HOUSE / GENESIS DOLLS' })
  @IsOptional()
  @IsString()
  subtitle?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ description: 'Token id of the tenant being given away.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  prizeTokenId?: number;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  entryCost?: number;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minTicketsToEnter?: number;

  @ApiPropertyOptional({
    default: true,
    description:
      'Require the entrant to currently hold a tenant. Leave true unless the raffle is deliberately open to non-holders.',
  })
  @IsOptional()
  @IsBoolean()
  holdersOnly?: boolean;

  @ApiPropertyOptional({ description: 'Cap per wallet. Omit for unlimited.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxEntriesPerUser?: number;

  @ApiProperty()
  @IsDateString()
  opensAt!: string;

  @ApiProperty()
  @IsDateString()
  closesAt!: string;
}
