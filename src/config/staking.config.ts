import { StakeDuration } from '@prisma/client';

/**
 * The five lock tiers from the Stake page, in one place.
 *
 * Reward values live here rather than in the database because they are policy,
 * not data — you want them in version control, reviewable in a diff. Note that
 * Stake.ticketsEarned snapshots the value at stake time, so editing this table
 * never changes the payout of a lock already in progress.
 */
export interface StakeTier {
  duration: StakeDuration;
  days: number;
  tickets: number;
  /** Shown on the tier cards: "7 DAYS". */
  label: string;
}

export const STAKE_TIERS: readonly StakeTier[] = [
  { duration: StakeDuration.DAYS_7, days: 7, tickets: 1, label: '7 DAYS' },
  { duration: StakeDuration.DAYS_14, days: 14, tickets: 2, label: '14 DAYS' },
  { duration: StakeDuration.DAYS_30, days: 30, tickets: 3, label: '30 DAYS' },
  { duration: StakeDuration.DAYS_60, days: 60, tickets: 4, label: '60 DAYS' },
  { duration: StakeDuration.DAYS_90, days: 90, tickets: 5, label: '90 DAYS' },
] as const;

const TIERS_BY_DURATION = new Map(STAKE_TIERS.map((tier) => [tier.duration, tier]));

export function getStakeTier(duration: StakeDuration): StakeTier {
  const tier = TIERS_BY_DURATION.get(duration);
  // Unreachable while the enum and this table agree — but if someone adds a
  // duration to schema.prisma and forgets this file, we want a loud failure
  // rather than a stake that silently earns zero tickets.
  if (!tier) {
    throw new Error(`No staking tier configured for duration "${duration}"`);
  }
  return tier;
}
