import { plainToInstance } from 'class-transformer';
import { IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString, MinLength, validateSync } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * Fail fast on bad configuration.
 *
 * Nest runs this before the app starts. A missing JWT_SECRET should crash the
 * process on boot with a clear message — not silently sign tokens with `""`
 * and let anyone forge a session.
 */
class EnvironmentVariables {
  @IsOptional()
  @IsString()
  NODE_ENV?: string;

  @IsOptional()
  @Transform(({ value }) => parseInt(value as string, 10))
  @IsInt()
  PORT?: number;

  @IsNotEmpty({ message: 'DATABASE_URL is required — see .env.example' })
  @IsString()
  DATABASE_URL!: string;

  @MinLength(32, {
    message:
      'JWT_SECRET must be at least 32 characters. Generate one with: openssl rand -base64 48',
  })
  JWT_SECRET!: string;

  @IsOptional()
  @IsString()
  RPC_URL?: string;

  @IsOptional()
  @Transform(({ value }) => ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase()))
  @IsBoolean()
  DEMO_MODE?: boolean;
}

export function validateEnv(config: Record<string, unknown>) {
  const parsed = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: false,
  });

  const errors = validateSync(parsed, { skipMissingProperties: false });

  if (errors.length > 0) {
    const details = errors
      .map((error) => Object.values(error.constraints ?? {}).join(', '))
      .join('\n  - ');
    throw new Error(`Invalid environment configuration:\n  - ${details}`);
  }

  return config;
}
