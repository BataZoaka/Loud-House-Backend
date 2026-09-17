import { ApiProperty } from '@nestjs/swagger';
import { IsEthereumAddress, IsNotEmpty, IsString } from 'class-validator';
import { Transform } from 'class-transformer';

export class NonceRequestDto {
  @ApiProperty({ example: '0x71Af6F0e1b2C3d4E5f60718293A4b5C6d7E8f900' })
  @IsEthereumAddress({ message: 'address must be a valid Ethereum address' })
  @Transform(({ value }) => String(value).toLowerCase())
  address!: string;
}

export class VerifySignatureDto {
  @ApiProperty({ description: 'The full EIP-4361 message the wallet was asked to sign.' })
  @IsString()
  @IsNotEmpty()
  message!: string;

  @ApiProperty({ description: 'The signature returned by the wallet.' })
  @IsString()
  @IsNotEmpty()
  signature!: string;
}

export class SessionDto {
  @ApiProperty()
  accessToken!: string;

  @ApiProperty()
  user!: {
    id: string;
    walletAddress: string;
    displayName: string | null;
    isAdmin: boolean;
  };
}
