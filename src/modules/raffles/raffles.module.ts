import { Module } from '@nestjs/common';
import { TicketsModule } from '@/modules/tickets/tickets.module';
import { RafflesController } from './raffles.controller';
import { RafflesService } from './raffles.service';
import { DrawService } from './draw.service';

@Module({
  imports: [TicketsModule],
  controllers: [RafflesController],
  providers: [RafflesService, DrawService],
  exports: [RafflesService],
})
export class RafflesModule {}
