# Supplementary README (Codex changes)

This file documents what was added/changed by Codex, why it was done, and how
to run the project locally.

## What changed and why

Build and toolchain fixes (required to compile and deploy):
- `biowatchcare/Cargo.toml`: add `[profile.release] overflow-checks = true`
  to satisfy Anchor build requirements.
- `biowatchcare/Anchor.toml`: set `[toolchain] anchor_version = "0.31.1"`
  to match the installed Anchor CLI and avoid version mismatch warnings.
- `biowatchcare/programs/biowatchcare/Cargo.toml`: update `anchor-lang` to
  `0.31.1` and add features (`no-idl`, `idl-build`, `cpi`) so the project
  builds cleanly with the CLI version in use.
- `biowatchcare/programs/biowatchcare/src/lib.rs`: simplify `Context` usage to
  `Context<InitializeConfig>` etc, and import `instructions::*` to keep the
  program module tidy.
- `biowatchcare/programs/biowatchcare/src/instructions/admin.rs`:
  replace `*config = GlobalConfig::new(...)` with `config.set_inner(...)` to
  avoid assignment to account data in Anchor 0.31.
- `biowatchcare/programs/biowatchcare/src/instructions/medical.rs`:
  add `#[instruction(token_hash: [u8; 32])]` to `IssueQrToken` so the PDA
  seeds can use `token_hash`.

Local validator workaround (WSL):
- `solana-test-validator` v3.0.13 fails under WSL with
  "Error checking to unpack genesis archive: Invalid argument".
  A working localnet validator is started using the older Solana 2.1.22
  binary already installed under
  `/home/ems/.local/share/solana/install/releases/stable-269449...`.

Client/test scaffolding (no IDL needed):
- `biowatchcare/package.json` and `biowatchcare/package-lock.json`:
  add a small Node setup with `@coral-xyz/anchor` and `mocha`.
- `biowatchcare/scripts/init-config.js`:
  a tiny client that builds the Anchor instruction discriminator manually
  and initializes the config PDA on localnet.
  It loads a keypair from `ANCHOR_WALLET` or `~/.config/solana/id.json`
  if available; otherwise it creates `.anchor/localnet-admin.json`
  (ignored by git) and requests an airdrop for local testing.
- `biowatchcare/tests/biowatchcare.js`:
  mocha tests that initialize the config PDA if missing, update the
  reimbursement threshold, and exercise the entity role lifecycle
  (register -> approve -> revoke).
- `.gitignore` (repo root):
  ignore `node_modules/`, `target/`, `test-ledger/` and log files.

## How to run (localnet, WSL)

### 1) Start the local validator (working binary)
Use the older Solana binary that works under WSL:

```bash
/home/ems/.local/share/solana/install/releases/stable-2694497991ec20761d820f8a39933222a1017bf6/solana-release/bin/solana-test-validator --ledger /tmp/solana-ledger-2-1 --reset
```

### 2) Point Solana CLI to localnet and fund your wallet

```bash
/home/ems/.local/share/solana/install/releases/stable-2694497991ec20761d820f8a39933222a1017bf6/solana-release/bin/solana config set --url http://127.0.0.1:8899 --keypair /home/ems/.config/solana/id.json
/home/ems/.local/share/solana/install/releases/stable-2694497991ec20761d820f8a39933222a1017bf6/solana-release/bin/solana airdrop 5
```

### 3) Build the program (no IDL)

```bash
cd /mnt/f/biowatchcare/Biowatchcare/biowatchcare
anchor build --no-idl -- --tools-version v1.52
```

### 4) Deploy the program

```bash
/home/ems/.local/share/solana/install/releases/stable-2694497991ec20761d820f8a39933222a1017bf6/solana-release/bin/solana program deploy \
  /mnt/f/biowatchcare/Biowatchcare/biowatchcare/target/deploy/biowatchcare.so \
  --program-id /mnt/f/biowatchcare/Biowatchcare/biowatchcare/target/deploy/biowatchcare-keypair.json
```

### 5) Install JS deps and initialize config

If you use Windows Node from WSL, run:

```bash
/mnt/c/Program\ Files/nodejs/npm install
/mnt/c/Program\ Files/nodejs/node.exe scripts/init-config.js 75000
```

If you want to use your existing WSL wallet file with Windows Node, set:

```
ANCHOR_WALLET=\\wsl.localhost\\Ubuntu\\home\\ems\\.config\\solana\\id.json
```

### 6) Run the mocha test

```bash
/mnt/c/Program\ Files/nodejs/npm test
```

Notes:
- The JS script/test manually encodes the Anchor instruction discriminator.
  This avoids needing an IDL in this environment.
- If the config PDA already exists, the test will only assert the account
  size (and will not overwrite it). If the admin does not match the current
  payer, the admin-only tests are skipped.
