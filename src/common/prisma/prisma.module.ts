import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * @Global means every other module can inject PrismaService without listing
 * PrismaModule in its imports. Worth it for the database client specifically —
 * do not reach for @Global casually, it hides dependencies.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
