import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { PrismaService } from './common/prisma/prisma.service';
import { PrismaExceptionFilter } from './common/filters/prisma-exception.filter';

/**
 * Prisma returns BigInt for the block-number columns, and JSON.stringify
 * throws on BigInt rather than serialising it. Teaching it to emit a string is
 * simpler than remembering to convert at every call site — and a string is the
 * right wire format anyway, since a block number can exceed Number.MAX_SAFE_INTEGER.
 */
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  app.setGlobalPrefix('api');
  app.use(helmet());

  // Explicit origin list, not `origin: true`. Reflecting any origin with
  // credentials enabled means any website can call this API as your logged-in
  // users.
  app.enableCors({
    origin: config.getOrThrow<string[]>('corsOrigins'),
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      // Strip properties with no matching DTO field. Without this, a client
      // can post {"isAdmin": true} and it flows into anything that spreads the
      // body into a Prisma write.
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  // Database errors become proper HTTP responses instead of bare 500s.
  app.useGlobalFilters(new PrismaExceptionFilter());

  const prisma = app.get(PrismaService);
  await prisma.enableShutdownHooks(app);
  app.enableShutdownHooks();

  if (config.get<string>('nodeEnv') !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('The Loud House API')
      .setDescription('Collection, staking vault and raffle room for 3,000 tenants.')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, swaggerConfig));
  }

  const port = config.getOrThrow<number>('port');
  await app.listen(port);

  logger.log(`The Loud House API listening on http://localhost:${port}/api`);
  if (config.get<boolean>('demoMode')) {
    logger.warn('DEMO_MODE is ON — on-chain ownership checks are bypassed. Do not ship this.');
  }
}

void bootstrap();
