/**
 * Typed configuration, loaded once at boot.
 *
 * Everything the app needs from the environment is read HERE and nowhere else.
 * No `process.env.WHATEVER` scattered through services — that is how you end up
 * shipping with a variable that was never set on the production box and only
 * finding out when a request hits that code path at 2am.
 */
export interface AppConfig {
  nodeEnv: string;
  port: number;
  corsOrigins: string[];
  demoMode: boolean;
  jwt: { secret: string; expiresIn: string };
  siwe: { domain: string; uri: string; statement: string };
  chain: { chainId: number; rpcUrl: string; nftContractAddress: string };
  indexer: { blockscoutApiUrl: string };
}

const toBool = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
};

export default (): AppConfig => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '4000', 10),
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  demoMode: toBool(process.env.DEMO_MODE, false),
  jwt: {
    secret: process.env.JWT_SECRET ?? '',
    expiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
  },
  siwe: {
    domain: process.env.SIWE_DOMAIN ?? 'localhost:3000',
    uri: process.env.SIWE_URI ?? 'http://localhost:3000',
    statement: process.env.SIWE_STATEMENT ?? 'Sign in to The Loud House.',
  },
  chain: {
    chainId: parseInt(process.env.CHAIN_ID ?? '1', 10),
    rpcUrl: process.env.RPC_URL ?? '',
    nftContractAddress: (process.env.NFT_CONTRACT_ADDRESS ?? '').toLowerCase(),
  },
  indexer: {
    // Blockscout, not OpenSea: OpenSea does not index Robinhood Chain, so
    // there is no marketplace API to read this collection from.
    blockscoutApiUrl: process.env.BLOCKSCOUT_API_URL ?? '',
  },
});
