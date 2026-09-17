import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { StakeDuration } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, Min } from 'class-validator';

export class CreateStakeDto {
  @ApiProperty({ example: 100, description: 'Token id of the tenant to lock.' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  tokenId!: number;

  @ApiProperty({ enum: StakeDuration, example: StakeDuration.DAYS_30 })
  @IsEnum(StakeDuration, {
    message: `duration must be one of: ${Object.values(StakeDuration).join(', ')}`,
  })
  duration!: StakeDuration;
}

/** Shape the Stake page renders for each row under ACTIVE STAKES. */
export class StakeViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() tokenId!: number;
  @ApiProperty() name!: string;
  @ApiPropertyOptional() imageUrl?: string | null;
  @ApiProperty({ enum: StakeDuration }) duration!: StakeDuration;
  @ApiProperty({ description: 'Lock length in days, e.g. 30.' }) durationDays!: number;
  @ApiProperty({ description: 'Tickets this lock pays out on withdrawal.' }) ticketsEarned!: number;
  @ApiProperty() startsAt!: Date;
  @ApiProperty() endsAt!: Date;

  /**
   * Derived, never stored. See the note on the Stake model in schema.prisma:
   * a matured lock is just ACTIVE with endsAt in the past, so the badge is
   * computed per request and is never stale.
   */
  @ApiProperty({ description: 'true while the countdown is still running.' })
  isLocked!: boolean;

  @ApiProperty({ description: 'Milliseconds left, 0 once complete.' })
  timeRemainingMs!: number;

  @ApiProperty({ description: 'true when the tenant can be withdrawn now.' })
  canUnstake!: boolean;
}
