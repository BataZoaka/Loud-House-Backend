import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import configuration from './config/configuration';
import { validateEnv } from './config/env.validation';
import { PrismaModule } from './common/prisma/prisma.module';
import { ChainModule } from './modules/chain/chain.module';
import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard';
import { CollectionModule } from './modules/collection/collection.module';
import { StakingModule } from './modules/staking/staking.module';
import { TicketsModule } from './modules/tickets/tickets.module';
import { RafflesModule } from './modules/raffles/raffles.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate: validateEnv,
    }),

    // Blunt but effective: 60 requests per minute per IP. The endpoints worth
    // protecting are /auth/nonce (free user rows) and /raffles/:slug/enter
    // (hammering it to win races). Tighten per-route once you see real traffic.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }]),

    PrismaModule,
    ChainModule,

    AuthModule,
    CollectionModule,
    TicketsModule,
    StakingModule,
    RafflesModule,
  ],
  providers: [
    // Registered globally so every route requires a JWT by default and you opt
    // out with @Public(). Failing closed beats failing open — see the comment
    // on the Public decorator.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
