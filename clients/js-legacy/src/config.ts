import { PublicKey } from '@solana/web3.js';
import { STAKE_POOL_PROGRAM_ID as DEFAULT_STAKE_POOL_PROGRAM_ID } from './constants';

/**
 * Configuration for the stake pool program ID.
 *
 * X1 fork only. Lets a consumer point the client at a different deployment
 * (a local test validator, a staging pool) without rebuilding.
 */
class StakePoolConfig {
  private programId: PublicKey | null = null;

  /**
   * The explicitly configured program ID, or null if none has been set.
   *
   * Callers that need to fall back to endpoint-based detection must use this
   * rather than {@link getProgramId}, which can never return null.
   */
  getOverride(): PublicKey | null {
    return this.programId;
  }

  /**
   * Get the configured program ID, or the default if not configured.
   */
  getProgramId(): PublicKey {
    return this.programId ?? DEFAULT_STAKE_POOL_PROGRAM_ID;
  }

  /**
   * Set a custom program ID.
   */
  setProgramId(programId: PublicKey): void {
    this.programId = programId;
  }

  /**
   * Reset to default program ID.
   */
  reset(): void {
    this.programId = null;
  }
}

// Singleton instance
export const stakePoolConfig = new StakePoolConfig();
