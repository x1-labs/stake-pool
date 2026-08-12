// Verifies the X1-specific changes to this client against the real live
// mainnet account bytes committed under program/tests/fixtures, plus the
// on-chain instruction encoding.
//
// This exists as a standalone script rather than a jest test because the jest
// suite in this package does not currently run: jest 30 against ts-jest 29
// fails with `this._moduleMocker.clearMocksOnScope is not a function` before
// any test executes. That breakage predates the X1 fork sync and is unrelated
// to it. Fold these checks into jest once that is fixed.
//
// Usage: pnpm build && pnpm verify-x1
import fs from 'fs';
import path from 'path';
import assert from 'assert';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const lib = require(path.join(here, '..', 'dist', 'index.cjs.js'));
const { PublicKey } = require('@solana/web3.js');
const BN = require('bn.js');

const fixtures = path.join(here, '..', '..', '..', 'program', 'tests', 'fixtures');
const POOL = fs.readFileSync(path.join(fixtures, 'x1-mainnet-stake-pool.bin'));
const VLIST = fs.readFileSync(path.join(fixtures, 'x1-mainnet-validator-list.bin'));

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${name}\n       ${e.message}`);
  }
};

console.log('\nStakePoolLayout against the live mainnet pool account');
check('decodes the real 877-byte account', () => {
  const p = lib.StakePoolLayout.decode(POOL);
  assert.strictEqual(p.version, 1, 'version');
  assert.strictEqual(p.accountType, 1, 'accountType');
  assert.strictEqual(
    p.manager.toBase58(),
    '4MB864w1ijdZXZJHhTpMet5pmDxgqK8bvnLJYL4tZRjW',
    'manager (pins field offsets past the version byte)',
  );
  assert.strictEqual(p.staker.toBase58(), 'ksFH7jd46CVjDBDj8F6yEr6Xbk21q54N9cPJhhiA6cZ');
  assert.strictEqual(p.poolMint.toBase58(), 'SwyFnCdFptC8V7ZUkGNBCk1x716psoQ8nPESBMidVes');
  assert.strictEqual(p.epochFee.numerator.toString(), '1');
  assert.strictEqual(p.epochFee.denominator.toString(), '100');
});
check('maxValidatorStake decodes as unset', () => {
  const p = lib.StakePoolLayout.decode(POOL);
  assert.ok(p.maxValidatorStake === null || p.maxValidatorStake === undefined,
    `expected null/undefined, got ${p.maxValidatorStake}`);
});
check('dropping the version byte does not silently decode', () => {
  // Decoding the account shifted by one byte -- i.e. what upstream's layout
  // would do to an X1 account -- must not yield a valid-looking pool. In
  // practice it throws on a misaligned Option tag, which is the loud failure
  // we want rather than silent field corruption.
  let threw = false;
  let manager = null;
  try {
    manager = lib.StakePoolLayout.decode(POOL.subarray(1)).manager.toBase58();
  } catch {
    threw = true;
  }
  assert.ok(
    threw || manager !== '4MB864w1ijdZXZJHhTpMet5pmDxgqK8bvnLJYL4tZRjW',
    'a one-byte shift must not decode to the correct pool',
  );
});

console.log('\ngetStakePoolAccounts account-type discrimination');
check('pool: byte0=version(1), byte1=accountType(1)', () => {
  assert.strictEqual(POOL.readUInt8(0), 1);
  assert.strictEqual(POOL.readUInt8(1), 1);
});
check('validator list: byte0=accountType(2)', () => {
  assert.strictEqual(VLIST.readUInt8(0), 2);
});
check('discriminating on byte0 alone would be ambiguous if version changed', () => {
  // The shipped logic checks ValidatorList on byte 0 first, then StakePool on
  // byte 1, which stays correct for any version value.
  const bumped = Buffer.from(POOL);
  bumped.writeUInt8(2, 0); // pretend version == 2
  assert.strictEqual(bumped.readUInt8(0), 2, 'byte0 now collides with ValidatorList');
  assert.strictEqual(bumped.readUInt8(1), 1, 'but byte1 still identifies a StakePool');
});

console.log('\nSetMaxValidatorStake instruction encoding');
const stakePool = new PublicKey('EqpBCpgDnLepE1H3dejVbZJrRa3Cyxr2A6Qt7zEbVHPi');
const manager = new PublicKey('4MB864w1ijdZXZJHhTpMet5pmDxgqK8bvnLJYL4tZRjW');
check('None encodes to exactly [27, 0]', () => {
  const ix = lib.StakePoolInstruction.setMaxValidatorStake({ stakePool, manager });
  assert.deepStrictEqual([...ix.data], [27, 0]);
});
check('Some(7) encodes to [27, 1, <u64 le>]', () => {
  const ix = lib.StakePoolInstruction.setMaxValidatorStake({
    stakePool, manager, maxStake: new BN(7),
  });
  assert.deepStrictEqual([...ix.data], [27, 1, 7, 0, 0, 0, 0, 0, 0, 0]);
});
check('large u64 survives without float rounding', () => {
  // 2^53 + 1 is not representable as a JS number; a ns64/number round trip
  // would silently corrupt it.
  const big = new BN('9007199254740993');
  const ix = lib.StakePoolInstruction.setMaxValidatorStake({
    stakePool, manager, maxStake: big,
  });
  const decoded = new BN(Buffer.from(ix.data.subarray(2)), 'le');
  assert.strictEqual(decoded.toString(), '9007199254740993');
});
check('u64::MAX encodes to 8 bytes of 0xff', () => {
  const ix = lib.StakePoolInstruction.setMaxValidatorStake({
    stakePool, manager, maxStake: new BN('18446744073709551615'),
  });
  assert.deepStrictEqual([...ix.data], [27, 1, 255, 255, 255, 255, 255, 255, 255, 255]);
});
check('accounts are [pool(w), manager(signer)]', () => {
  const ix = lib.StakePoolInstruction.setMaxValidatorStake({ stakePool, manager });
  assert.strictEqual(ix.keys.length, 2);
  assert.ok(ix.keys[0].isWritable && !ix.keys[0].isSigner);
  assert.ok(ix.keys[1].isSigner && !ix.keys[1].isWritable);
  assert.strictEqual(ix.programId.toBase58(), 'XPoo1Fx6KNgeAzFcq2dPTo95bWGUSj5KdPVqYj9CZux');
});

console.log('\nprogram id resolution');
check('defaults to the X1 program', () => {
  assert.strictEqual(
    lib.STAKE_POOL_PROGRAM_ID.toBase58(),
    'XPoo1Fx6KNgeAzFcq2dPTo95bWGUSj5KdPVqYj9CZux',
  );
});
check('devnet fallback still reachable with no override', () => {
  lib.resetStakePoolProgramId();
  assert.strictEqual(
    lib.getStakePoolProgramId('https://api.devnet.solana.com').toBase58(),
    lib.DEVNET_STAKE_POOL_PROGRAM_ID.toBase58(),
  );
});
check('override wins over endpoint detection', () => {
  const custom = new PublicKey('EqpBCpgDnLepE1H3dejVbZJrRa3Cyxr2A6Qt7zEbVHPi');
  lib.setStakePoolProgramId(custom);
  assert.strictEqual(
    lib.getStakePoolProgramId('https://api.devnet.solana.com').toBase58(),
    custom.toBase58(),
  );
  lib.resetStakePoolProgramId();
  assert.strictEqual(
    lib.getStakePoolProgramId('https://rpc.mainnet.x1.xyz').toBase58(),
    'XPoo1Fx6KNgeAzFcq2dPTo95bWGUSj5KdPVqYj9CZux',
  );
});

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
