import { PublicKey } from '@solana/web3.js';
import { STAKE_POOL_PROGRAM_ID as DEFAULT_STAKE_POOL_PROGRAM_ID } from './constants';

/**
 * Configuration for stake pool program ID
 */
class StakePoolConfig {
  private programId: PublicKey | null = null;

  /**
   * Get the configured program ID, or the default if not configured
   */
  getProgramId(): PublicKey {
    return this.programId ?? DEFAULT_STAKE_POOL_PROGRAM_ID;
  }

  /**
   * Set a custom program ID
   */
  setProgramId(programId: PublicKey): void {
    this.programId = programId;
  }

  /**
   * Reset to default program ID
   */
  reset(): void {
    this.programId = null;
  }
}

// Singleton instance
export const stakePoolConfig = new StakePoolConfig();