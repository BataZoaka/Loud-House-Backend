import { Module } from '@nestjs/common';
import { TicketsModule } from '@/modules/tickets/tickets.module';
import { StakingController } from './staking.controller';
import { StakingService } from './staking.service';

@Module({
  imports: [TicketsModule],
  controllers: [StakingController],
  providers: [StakingService],
  exports: [StakingService],
})
export class StakingModule {}
