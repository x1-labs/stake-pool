# Upstream Sync & Upgrade Path — x1-labs/stake-pool

**Date:** 2026-08-10
**Author:** prepared for @nick
**Status:** proposed, not yet started

---

## 1. Situation

`x1-labs/stake-pool` forked `solana-program/stake-pool` and diverged at
`f8ebfd2` (2025-05-27).

| | |
|---|---|
| Commits behind upstream | **433** (~390 dependabot, ~43 substantive) |
| Commits ahead | **17** (6 logical changes) |
| Merge base | `f8ebfd2` 2025-05-27 |
| Target | `upstream/main` (`40ce735`) |

The fork is **live on X1 mainnet**, which makes this a program-upgrade problem,
not just a merge problem.

### Verified live state (queried 2026-08-10)

| Item | Value |
|---|---|
| Program | `XPoo1Fx6KNgeAzFcq2dPTo95bWGUSj5KdPVqYj9CZux` |
| Loader | `BPFLoaderUpgradeab1e…` — **upgradeable** |
| ProgramData | `71kT6Tcm7YijGrJxhmd1BcspHMZXysGa2ec2Jr5mVnFi` |
| Upgrade authority | `Ha194AW38mWCMTGEt3kUQrrvz7eXKpsNRFQx6WrhMQNw` |
| Last deploy slot | 6009998 |
| Pool | `EqpBCpgDnLepE1H3dejVbZJrRa3Cyxr2A6Qt7zEbVHPi` (877 bytes) |
| Reserve | ~29.96 SOL, 12 validators enrolled |
| X1 mainnet runtime | solana-core **3.1.14** (feature-set 1790894356) |
| X1 testnet runtime | solana-core **4.0.3** (feature-set 2137973216) |

---

## 2. Why now — we are exposed to two upstream security fixes

This is the actual driver. The deployed X1 program predates these:

| Commit | Issue |
|---|---|
| `0e56295` | **Cluster-restart hijack.** When a stake account is reset to `Initialized` during a cluster restart, the pool merges the funds back but never updates validator status — an attacker can take control of that stake account and still have it counted by the pool. Same commit also blocks decrease-stake on non-`Active` validators. |
| `41b24fe` | **Removed-validator mis-accounting.** Running update-balance on a just-removed validator wrongly subtracts its active stake from the pool. Consequences: stake/SOL depositors get **too many** pool tokens, withdrawers get **too little**, and the manager over-collects fees at the next epoch boundary. |
| `09734fd` | Checked math on reserve accounting can hard-fail after a rent increase; upstream switched to saturating math. |
| `dad5ecd` | Fee check used `map` instead of `and_then`, comparing `Some(..)` against `None` — incorrect fee validation. |
| `c1c61c6` | Withdrawal fee increase additionally capped at 50 bps (previously only a 1.5× factor). |
| `183cb6c` | Withdraw path could split an active stake below minimum delegation. |

X1 mainnet is small today (~30 SOL, 12 validators), so blast radius is low —
but `0e56295` and `41b24fe` are both economically exploitable and should not sit
unpatched.

---

## 3. Hard constraints

### C1 — On-chain layout is frozen (non-negotiable)

The live pool account was decoded and confirms the fork's layout:

```
offset      size  field
[0]            1  version            = 0x01   <- fork-only, PREPENDED
[1]            1  account_type       = 0x01 (StakePool)
[2..436]     434  upstream StakePool body (as currently encoded)
[436]          1  max_validator_stake Option tag = 0x00 (None)
[437..693]   256  _reserved[256]     = all zero
[693..877]   184  zero slack (unused Option headroom)

allocated size    = 877 = get_packed_len::<StakePool>()  (maximum encoding)
current encoding  = 693
```

`get_packed_len` returns the *maximum* encoding, with every `Option` populated,
and the account is allocated at that size. This pool encodes to only 693 bytes
because seven fields are currently `None`, leaving 184 bytes of zero slack:
`next_epoch_fee` +16, `preferred_deposit` +32, `preferred_withdraw` +32,
`next_stake_withdrawal_fee` +16, `sol_deposit_authority` +32,
`sol_withdraw_authority` +32, `next_sol_withdrawal_fee` +16,
`max_validator_stake` +8 = 184.

`try_from_slice_unchecked` tolerates the trailing slack, and setting a cap later
grows the encoding by only 8 bytes (693 → 701), so it fits without a realloc.

**Any program we deploy to `XPoo1Fx6…` must deserialize these exact bytes.**
The prepended `version` byte means our layout and upstream's are mutually
unreadable — this is permanent and must be re-applied on every future sync.

### C2 — Runtime version gap — ✅ RESOLVED, NOT A BLOCKER

Upstream requires Rust **1.93.0** and pins Solana CLI **4.0.3**; X1 mainnet runs
**3.1.14**. This was the main open risk. It has been **empirically resolved**
(see §8 V5 for the evidence) — **the program sync is fully decoupled from the
cluster v4 upgrade and can ship before, after, or independently of it.**

The governing fact: **SBPF version acceptance is controlled by feature gates,
not by the validator client version.** On *both* X1 mainnet and X1 testnet:

| Feature | State on X1 (both clusters) |
|---|---|
| SIMD-0166 — deploy/execute SBPFv1 | **inactive** |
| SIMD-0178/0189/0377 — deploy/execute SBPFv3 | **inactive** |
| SIMD-0161 — *disables* SBPFv0 execution | **inactive** (so SBPFv0 is enabled) |

X1 testnet is already on 4.0.3 and *still* only accepts SBPFv0. So upgrading
mainnet to v4 **will not** change what bytecode is accepted, and testnet being
on 4.0.3 does not make it a weaker proxy for mainnet on this axis.

> **Build constraint (operational):** always build with the **default
> `--arch v0`**. Building `--arch v1/v2/v3` produces bytecode X1 will **reject
> on both clusters**, and the v4 cluster upgrade does not change that. Do not
> "modernize" the arch flag.

### C3 — Upgrade in place

Program is upgradeable and authority is held, so we deploy over
`XPoo1Fx6…`. **No pool migration, no re-enrollment, no new program ID.**

---

## 4. Target and strategy

**Target: `upstream/main`.** Note `program@v2.1.0` is a *release branch*, not an
ancestor of main. The program-source delta between them is small and is a
genuine correctness fix (`183cb6c`, prevents splitting active stake below
minimum delegation, reads `get_minimum_delegation()` dynamically so it is
runtime-agnostic). Main is the better target.

**Strategy: replay our delta onto upstream, do not merge.**

Upstream rewrote `processor.rs` (563 lines), `state.rs`, all tests, and replaced
the `scripts/*.mjs` build system with a `Makefile`. Merging means fighting
conflicts in wholesale-rewritten files across ~390 dependabot commits of noise.
Our delta is only 6 logical changes.

```
git checkout -b sync/upstream-2026-08 upstream/main
```

Then replay as a curated patch series, so the fork becomes
`upstream/main + 6 reviewable commits` and the *next* sync is trivial.

### Scope: program first, clients after

Phase 1 lands `program/` only — the security fixes, independently reviewable
and deployable. Phase 2 syncs CLI / JS / Python.

---

## 5. Phase 1 — the patch series

Branch: **`sync/upstream-2026-08`** (branched from `upstream/main` at `40ce735`;
upstream tracking deliberately unset so nothing can push to upstream).

| # | Patch | Commit | Status |
|---|---|---|---|
| **P1** | X1 program ID — `declare_id!` (now via `solana_pubkey`) + `program-id.md` | `0736d33` | ✅ |
| **P2** | **Layout preservation** — `version: u8` prepended, `max_validator_stake` + `_reserved: [u8; 256]` appended, hand-written `Default`, `process_initialize` writes them; adds `CURRENT_STAKE_POOL_VERSION`; layout locked by 3 tests against a committed mainnet account dump | `17660f5` | ✅ |
| **P3** | Max-validator-stake feature — `SetMaxValidatorStake` ix + builder, `ExceedsMaxValidatorStake` error, `process_set_max_validator_stake`, guard in `process_increase_validator_stake` | `55ec0e4` | ✅ |
| **P4** | Integration tests — 6 X1 cases in `program/tests/increase.rs` + `set_max_validator_stake` harness helper | `ca8a853` | ✅ |

Plus `1b52cc6` — validator-list layout lock (gate V4).

**Phase 1 (program) is complete.** Full suite 294 passed / 0 failed (plus the
V4 test, 295). V1, V2, V3, V4 and V5 all pass. The only remaining pre-mainnet
gate is **V6 (testnet lifecycle)**; V7 is a Phase 2 concern, not a
program-deploy blocker.

P2 and P3 were one commit in our history (`173ec68`); split them, because P2 is
the consensus-critical one and deserves isolated review.

### Wire compatibility, as landed

Both discriminants are pinned by tests rather than assumed:

- **Instruction: `SetMaxValidatorStake` = 27, unchanged from deployed.** Upstream
  ends at 26 (`WithdrawSolWithSlippage`) and variants 0–26 are identical in order
  to the deployed program, so appending reproduces the deployed encoding exactly.
  Existing X1 clients keep working. Locked by
  `instruction::x1_test::set_max_validator_stake_discriminant_is_stable`.
- **Error: `ExceedsMaxValidatorStake` moves 43 → 45.** Upstream claimed 43
  (`EpochRewardDistributionInProgress`) and 44 (`TooManyValidatorsInPool`) while
  we were behind. Appending preserves upstream's canonical codes, which are
  emitted by live paths and decoded by shared tooling; our error has never been
  emitted on mainnet because `max_validator_stake` is `None`. Locked by
  `error::x1_test::error_discriminants_match_upstream`.

> ⚠️ If upstream ever appends an instruction variant, the discriminant test
> fails. The fix is to place the **new upstream variant before ours**, keeping
> 27 for `SetMaxValidatorStake` — not to renumber ours.

### Deviations from the pre-sync fork (deliberate)

1. `StakePool::default()` now uses `AccountType::default()` (`Uninitialized`)
   rather than `AccountType::StakePool`, matching upstream's derived-`Default`
   semantics so upstream's tests keep their assumptions. No on-chain effect —
   `process_initialize` sets `account_type` explicitly.
2. Upstream removed `PrintProgramError`; the error message is registered through
   the `ToStr` impl instead.
3. The old `test_max_validator_stake_limit` was not ported verbatim — it
   contained a dead `if result.is_some() { }` block asserting nothing. Replaced
   with six focused tests: cap exceeded (additional + non-additional), exact-cap
   boundary, set/clear round trip, wrong-manager rejection, and
   blocked-then-cleared.

### Known limitation (carried over, not introduced)

`max_validator_stake` constrains **only staker-initiated increases**. It does not
limit `DepositStake`, so a depositor can still push a validator above the cap.
It is a staker-side policy control, not a hard invariant. Worth deciding whether
to close this gap **before** setting a cap on mainnet, since the name implies a
stronger guarantee than it delivers. Closing it would be a behavior change and
belongs in its own patch after the sync lands.

### Where the max-stake guard now goes

Upstream restructured `process_increase_validator_stake` and added its own
validator-status check (from security fix `0e56295`). Our guard must move to
**after** that check and **before** the minimum-delegation math:

```rust
if validator_stake_info.status != StakeStatus::Active.into() {
    msg!("Validator is marked for removal and no longer allows increases");
    return Err(StakePoolError::ValidatorNotFound.into());
}

// >>> X1: max validator stake guard goes HERE <<<
if let Some(max_stake) = stake_pool.max_validator_stake { … }

let stake_space = std::mem::size_of::<stake::state::StakeStateV2>();
```

`ValidatorStakeInfo::stake_lamports()` still exists upstream (`state.rs:722`),
so the guard body replays unchanged.

---

## 6. API migration checklist

Upstream migrated off the monolithic `solana-program` crate to granular
Solana 3.x crates. Every replayed patch must be rewritten against:

| Was | Now |
|---|---|
| `solana_program::pubkey::Pubkey` | `solana_pubkey::Pubkey` |
| `solana_program::declare_id!` | `solana_pubkey::declare_id!` |
| `solana_program::account_info::AccountInfo` | `solana_account_info::AccountInfo` |
| `solana_program::program_error::ProgramError` | `solana_program_error::ProgramError` |
| `solana_program::borsh1::*` | `solana_borsh::v1::*` |
| `solana_program::msg` | `solana_msg::msg` |
| `solana_program::stake::state::*` | `solana_stake_interface::state::*` |
| `spl_token_2022` | `spl_token_2022_interface` |
| `sol_memcmp(..)` | now **`unsafe`** — requires `unsafe { }` block |
| `minimum_stake_lamports(&Meta, u64)` | `minimum_stake_lamports(u64, u64)` — takes `rent_exempt_reserve` directly |
| `minimum_reserve_lamports(&Meta)` | `minimum_reserve_lamports(u64)` |
| `ValidatorStakeInfo::is_not_removed()` | split into `is_removed()` / `is_active()` |
| `pub(crate) check_manager_fee_info` | now `pub` |
| `BigVec` | `BigVec<'_>` (explicit lifetime) |

Also: `pub use solana_program;` was **removed** from `lib.rs` — anything
downstream relying on that re-export breaks.

### Toolchain

- `rust-toolchain.toml`: `1.84.1` → **`1.93.0`**
- Formatting/lint nightly: `nightly-2026-01-22`
- Solana CLI: local `2.2.20` → **`4.0.3`** (`workspace.metadata.cli.solana`)
- Build system: `scripts/*.mjs` → `Makefile`; CI workflows rewritten
- `cargo spellcheck` is enforced — the stalled `sync/program-v2.0.2` branch shows
  three separate commits fighting spellcheck/format. Run `make spellcheck` and
  `make format` **before** pushing to save a round trip.

---

## 7. Behavioral changes that affect X1 ops

These change runtime behavior even though they aren't layout changes:

1. **`MAX_VALIDATORS_TO_UPDATE: 5 → 4` — not a breaking change.**
   `processor.rs` never references this constant; the program is **not**
   enforcing a batch limit and processes whatever validator stake accounts it is
   handed, bounded only by the compute budget. The constant only chunks the
   validator list inside the `update_stake_pool()` instruction *builder* and the
   equivalent JS/Python client loops, which derive the chunk and its
   `start_index` from the same constant and so cannot desync.

   Consequences: tooling that hardcodes 5 keeps working exactly as it does
   today; it just retains the compute-headroom risk that motivated upstream's
   reduction (`d764ba8`). Rebuilt clients simply send more, smaller
   transactions. With 12 validators it is 3 instructions either way.

   *(An earlier draft of this plan claimed batches of 5 would start failing.
   That was wrong — there is no on-chain enforcement.)*
2. **`MAX_WITHDRAWAL_FEE_INCREASE` redefined.** Same name, new meaning: was a
   1.5× *factor*, now an absolute **50 bps** cap. The old factor moved to
   `MAX_WITHDRAWAL_FEE_INCREASE_FACTOR`. Both now apply.
3. **New `MAX_VALIDATORS_IN_POOL: u32 = 20_000`** cap.
4. **Minimum-delegation handling — measured, impact is negligible.** Verified
   2026-08-10 via `getStakeMinimumDelegation`: X1 mainnet **and** testnet both
   return **1 lamport**. The feature *"Raise minimum stake delegation to 1.0
   SOL #24357"* is **inactive** on X1. Upstream's `183cb6c` adds
   `stake_minimum_delegation` into `minimum_lamports_with_tolerance`; at 1
   lamport that delta is negligible, and the code reads the value dynamically,
   so it adapts correctly. No action needed for the 12 existing validator stake
   accounts — but re-check if X1 ever activates that feature.
5. **X1 still uses the native stake program.** SIMD-0196 *"Migrate Stake
   program to Core BPF"* and SIMD-0490 *"Upgrade BPF Stake Program to v5.0.0"*
   are both **inactive** on X1 mainnet.
6. **Tests now load a BPF stake program fixture**
   (`program/tests/fixtures/solana_stake_program.so`, built from Solana master
   with **1 SOL** minimum delegation). Combined with (4) and (5), the suite
   exercises a configuration X1 does not run: BPF stake program at 1 SOL
   minimum, versus X1's native stake program at 1 lamport. Green tests are
   therefore **necessary but not sufficient** — they do not prove X1 mainnet
   correctness. That is what gates V3, V4 and V6 are for.

---

## 8. Validation gates

Ordered. Do not skip; do not reorder.

- **V1 — Build — ✅ PASSING.** Builds clean on Rust 1.93 / Solana 4.0.3
  (`cargo-build-sbf 4.0.0`, platform-tools v1.53); fmt and clippy clean.
- **V2 — Test suite — ✅ PASSING.** Full `cargo test-sbf`: **294 passed, 0
  failed**, including the six X1 max-stake tests from P4 and the four
  discriminant/layout lock tests from P2/P3.
- **V3 — Byte-compatibility (most important gate) — ✅ IMPLEMENTED, PASSING.**
  Landed in P2. A byte-for-byte dump of the live mainnet pool account is
  committed at `program/tests/fixtures/x1-mainnet-stake-pool.bin` (877 bytes,
  captured 2026-08-10), locked by three unit tests in `program/src/state.rs`:

  | Test | Asserts |
  |---|---|
  | `x1_mainnet_pool_layout` | real account deserializes; `version == 1`, `account_type == StakePool`, `max_validator_stake == None`, `_reserved` zeroed, `is_valid()`; manager/staker/validator-list/reserve/mint match the run log (this pins field *offsets*); fees 1%/2%/3%; re-serialization reproduces on-chain bytes exactly; trailing slack is zero |
  | `x1_version_byte_precedes_account_type` | the one byte that diverges us from upstream serializes first |
  | `x1_max_validator_stake_fits_allocation` | `None`→`Some` grows 693→701, still ≤ 877, so setting a cap needs no realloc |

  Run with `cargo test -p spl-stake-pool --lib x1_`. **If these fail, do not
  deploy — fix the struct, never the test.**
- **V4 — Validator-list compatibility — ✅ IMPLEMENTED, PASSING.** Landed in
  `1b52cc6`. `state::test::x1_mainnet_validator_list_layout` runs upstream's
  raw-offset accessors (`memcmp_pubkey` over bytes 41..73, `is_active`,
  `is_removed`, `status` at byte 40) against the real account bytes from
  `2fg7PRAYkfj2ghcd7W4nsWMa2CzQ1Q83Br6cXc9UUgHc`, plus header/`max_validators`
  checks and an exact round-trip. This matters because a wrong offset or
  changed status interpretation *mis-accounts the pool silently* rather than
  failing loudly — the exact failure mode upstream's `41b24fe` fix addressed.

  Fixture is the 885-byte used prefix (9-byte header + 12 × 73); the live
  account is 73009 bytes and the remainder was verified all-zero.
- **V5 — Runtime compatibility with 3.1.x — ✅ ALREADY VERIFIED 2026-08-10.**
  Re-run only if the toolchain or arch flag changes. Evidence:

  1. Built `upstream/main`'s program with the **Solana 4.0.3** toolchain
     (`cargo-build-sbf 4.0.0`, platform-tools v1.53, Rust 1.93.0).
     `--arch` defaults to **v0**; clean-room rebuilds per arch confirmed the
     encoding (distinct sizes prove real rebuilds, not cache reuse):

     | build | `e_machine` | `e_flags` | size |
     |---|---|---|---|
     | **default** | 263 | **0 (SBPFv0)** | 334264 |
     | `--arch v1` | 263 | 1 | 334328 |
     | `--arch v2` | 263 | 2 | 334624 |
     | `--arch v3` | 247 | 3 | 311208 |

     ⚠️ `cargo-build-sbf` **does not rebuild when only `--arch` changes** — it
     silently reuses the cached artifact. Always wipe `target/deploy` and
     `target/sbpf-solana-solana` between arch comparisons or you will read a
     stale binary and reach the wrong conclusion.

  2. The currently-deployed X1 program is `e_machine=247, e_flags=0`; the new
     build is `e_machine=263, e_flags=0`. Both SBPFv0, but the **ELF machine
     type differs** (old `bpfel-unknown-none` vs new `sbpf-solana-solana`
     target), so this was tested rather than assumed.

  3. Ran a local `solana-test-validator` from **3.1.10** with SBPFv1/v3
     deployment deactivated, giving a feature posture **byte-identical to X1
     mainnet** (verified by querying both with the *same* 4.0.3 CLI — note the
     3.1.10 CLI renders a different, older feature table and will appear to
     disagree; that is a CLI artifact, not a cluster difference).

  4. Deployed the new binary there — **succeeded** — then invoked it with
     deliberately invalid instruction data:
     ```
     Program … invoke [1]
     Program log: Error: BorshIoError
     Program … consumed 906 of 200000 compute units
     ```
     The program's *own* code ran and raised its own Borsh error. This proves
     **load + execute**, not merely deploy-time ELF verification.
- **V6 — Testnet lifecycle.** Deploy to X1 testnet, then exercise the full
  lifecycle end to end: create pool → deposit SOL → add validators →
  increase → update balance → decrease → withdraw → `SetMaxValidatorStake` →
  confirm the cap rejects an over-limit increase.
- **V7 — Ops tooling.** Re-run the foundation-pool runbook against testnet.
  Low risk: the runbook's behavior is unchanged by the sync (see §7 item 1 —
  `MAX_VALIDATORS_TO_UPDATE` is not enforced on-chain). This gate is really
  about the *client* changes in Phase 2, so it can run alongside those rather
  than blocking the program deploy.

---

## 9. Mainnet deployment & rollback

**Take the rollback artifact first.**

```bash
# 1. Snapshot the currently deployed program — THIS IS THE ROLLBACK ARTIFACT
solana -u https://rpc.mainnet.x1.xyz program dump \
  XPoo1Fx6KNgeAzFcq2dPTo95bWGUSj5KdPVqYj9CZux \
  ./rollback/XPoo1Fx6-slot6009998.so

# 2. Snapshot pool + validator list state (pre-upgrade evidence)
solana -u … account EqpBCpgDnLepE1H3dejVbZJrRa3Cyxr2A6Qt7zEbVHPi --output-file …
solana -u … account 2fg7PRAYkfj2ghcd7W4nsWMa2CzQ1Q83Br6cXc9UUgHc  --output-file …

# 3. Write the new program to a buffer (does NOT go live)
solana -u … program write-buffer ./target/deploy/spl_stake_pool.so

# 4. Deploy from buffer, authority Ha194AW38mWCMTGEt3kUQrrvz7eXKpsNRFQx6WrhMQNw
solana -u … program deploy --buffer <BUFFER> \
  --program-id XPoo1Fx6KNgeAzFcq2dPTo95bWGUSj5KdPVqYj9CZux
```

**Post-upgrade smoke test, in order, halting on any failure:**
1. Re-read the pool account — assert bytes **unchanged** and still parsing.
2. `stake-pool list` — fees, reserve, and all 12 validators present.
3. `update-pool` for one epoch — confirm balances reconcile.
4. Small deposit-SOL and withdraw-SOL round trip.

**Rollback:** redeploy `rollback/XPoo1Fx6-slot6009998.so` over the same program
ID. Because the layout is preserved in both directions, rollback is safe and
requires no state migration — this is a direct benefit of constraint C1.

**Timing:** deploy early in an epoch, right after a successful `update-pool`, so
there is maximum runway before the next epoch boundary rolls fees.

---

## 10. Phase 2 — clients — ✅ COMPLETE

| Patch | Commit |
|---|---|
| CLI — `set-max-validator-stake` command, `CliStakePool.max_validator_stake` display | `f3699bf` |
| js-legacy — program ID, layout, config override, `setMaxValidatorStake` | `ae00fb4` |
| python — program ID, layouts, `StakePool.version` / `max_validator_stake` | `abce84e` |
| program — pin the `None` wire encoding the clients must satisfy | `d40e0b8` |

All three clients pick up `MAX_VALIDATORS_TO_UPDATE` 5 → 4 automatically; it only
changes batch sizing, not wire format (see §7 item 1).

### Five latent bugs in the pre-sync fork, fixed rather than replayed

Replaying the fork's client code verbatim would have carried all of these
forward. Each is fixed in the commit above and, where it is a wire-format
constraint, pinned by a test.

1. **JS `getStakePoolProgramId` had unreachable code.** It branched on
   `stakePoolConfig.getProgramId()`, which falls back to the default and so is
   never falsy — the devnet branch was dead, and devnet consumers silently got
   the mainnet program ID. Split out a nullable `getOverride()`.
2. **JS `setMaxValidatorStake` could never clear the cap.** It emitted a
   fixed-width 10-byte payload; `try_from_slice` rejects trailing bytes, and
   `None` encodes to 2. It also used `ns64` — signed, number-based — so any cap
   above 2^53 would be corrupted. Now hand-built and pinned by
   `set_max_validator_stake_none_rejects_trailing_bytes`.
3. **JS `getStakePoolAccounts` misidentified account types.** It read byte 0,
   which for a pool is now `version`, not `accountType`. Correct only while
   `version == AccountType.StakePool == 1`; bumping `version` would have made
   every pool decode as a validator list.
4. **Python modelled `Option<u64>` as a bare `Int64ul`.** An unset cap decoded
   as `0` — not "no limit" but "a cap of zero", which blocks every increase —
   and a set cap read the option tag as its low byte. Now uses the same
   option-byte + `Switch` pattern as the other optional fields.
5. **Python allocated pool accounts at the wrong size.** `STAKE_POOL_LAYOUT`
   exists only to supply `sizeof()` when creating the account; the fork's
   version summed to 620 against the program's 877, so any pool created through
   the Python client would have been undersized. Now exactly 877, asserted.

### Verification

- CLI: builds, clippy + fmt clean, subcommand help correct, invalid amount and
  invalid pubkey both exit 1.
- Python: `sizeof()` == 877 and the committed live mainnet account decodes to
  version 1, the run-log manager/staker/mint, and `max_validator_stake` `None`.
  flake8 and mypy clean.
- js-legacy: `tsc` and rollup build clean, eslint clean, and
  **`pnpm verify-x1`** (`clients/js-legacy/scripts/verify-x1.mjs`, 12 checks)
  passes — it decodes the real mainnet pool, confirms a one-byte shift does not
  decode, checks account-type discrimination survives a version bump, and
  verifies the instruction encoding including `u64::MAX` and values above 2^53.

> ⚠️ **The js-legacy jest suite does not run, on upstream as well as here.**
> jest 30 against ts-jest 29 throws
> `this._moduleMocker.clearMocksOnScope is not a function` before any test
> executes. Confirmed pre-existing by stashing every X1 change and running
> against pristine `upstream/main`, where it fails identically. Fixing it means
> a jest/ts-jest dependency bump that should be decided on its own merits, so it
> was left alone and `verify-x1` covers the X1-specific surface in the meantime.
> **This is the one real gap in Phase 2** — upstream's own JS tests, including
> the `decodeDepositSol` fix in `40ce735`, are currently unexercised.

---

## 11. Branch hygiene

Stale branches from earlier attempts — resolve once Phase 1 lands:

| Branch | Disposition |
|---|---|
| `sync/program-v2.0.2` | Superseded by this plan. Mine it for the spellcheck/format fixes, then delete. |
| `hotfix/merge_issues`, `temp/extra-files` | Inspect and delete. |
| `feature/realloc-validator-list` | 4 commits (`ReallocValidatorList` ix + CLI + JS + tests) — **not yet in `main`**. Decide whether to rebase onto the sync branch or drop. |
| `ops/foundation-stake-pool` | Keep — holds the run log and runbook. Rebase after the sync. |
| `.idea/`, `keys/` | Currently untracked in working tree; confirm `.gitignore` covers them before any commit. |

---

## 12. Open items

1. ~~Confirm a Solana-4.0.3-toolchain build loads on X1's 3.1.14 runtime.~~
   ✅ **Resolved 2026-08-10** — verified load *and* execute. See §8 V5.
   Consequence: **this sync does not depend on the mainnet v4 upgrade.**
2. ~~Confirm X1 mainnet's stake-program minimum delegation.~~
   ✅ **Resolved 2026-08-10** — 1 lamport, native stake program, 1-SOL feature
   inactive. Impact negligible. See §7 items 4–5.
3. **Still open:** confirm the `Ha194AW38mWCMTGEt3kUQrrvz7eXKpsNRFQx6WrhMQNw`
   upgrade-authority keypair is available (USB per prior notes) and its holder
   is on-call for the deploy window.
4. **Still open:** if the mainnet v4 upgrade lands first, re-run V5 against the
   new runtime. It should be a no-op — feature gates, not client version,
   govern SBPF acceptance, and X1 testnet on 4.0.3 already demonstrates the
   posture is unchanged — but it is cheap to re-confirm.
