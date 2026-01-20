# BioWatchCare (Solana + Anchor)

BioWatchCare is a Solana smart contract for managing hashed patient identities, consents, prescriptions, QR tokens, dispensing, invoices, and reimbursement claims. The program stores **only hashes, timestamps, statuses, and events** on-chain. Medical documents and personal data remain off-chain.

## Key Principles

- **No medical data in clear text on-chain.** Only hashes and timestamps are stored.
- **Patients only grant/revoke access.** They do not write medical data.
- **All transaction fees and rent are paid by a single ADMIN.**
- **All actors must sign actions that concern them.**

---

## Comment concevoir le backend pour payer toutes les transactions (admin unique payeur)

### A) Concepts

**Fee payer (transaction)** vs **Anchor payer (rent)** are separate concerns:

- **Fee payer**: the account that pays the network transaction fee (`feePayer` in the transaction).
- **Anchor payer**: the account specified in the instruction `#[account(init, payer = admin)]` that pays **rent** for new accounts.

In this program:
- **Fee payer** must always be the ADMIN (set client-side).
- **Anchor payer** is always the ADMIN account passed into every instruction context.

### B) Flux multi-signatures

1. Backend builds a transaction with the instruction(s).
2. Backend sets `feePayer = ADMIN` and recent blockhash.
3. Backend sends the transaction to the user to collect their signature (patient/doctor/pharmacist/etc.).
4. Backend receives the partially signed transaction.
5. Backend signs it with ADMIN.
6. Backend submits with `sendRawTransaction`.

This ensures **users sign but never pay**, and the **ADMIN pays everything**.

### C) Pseudo-code TypeScript (@solana/web3.js)

> The examples below show **admin as fee payer and rent payer**, and **user as co-signer only**.

#### 1) Patient `grant_consent` (patient + admin, admin pays)

```ts
import { Transaction } from "@solana/web3.js";

async function grantConsent({
  connection,
  program,
  adminKeypair,
  patientKeypair,
  patientIdHash,
  granteePubkey,
  scopes,
  expiresAt,
}) {
  const ix = await program.methods
    .grantConsent(patientIdHash, granteePubkey, scopes, expiresAt)
    .accounts({
      admin: adminKeypair.publicKey,
      patientSigner: patientKeypair.publicKey,
      patient: await program.account.patientProfileAddress(patientIdHash),
      consent: await program.account.consentAddress(patientIdHash, granteePubkey),
    })
    .instruction();

  const tx = new Transaction().add(ix);
  tx.feePayer = adminKeypair.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

  // User signs first (no fee payer responsibility)
  tx.partialSign(patientKeypair);

  // Backend admin signs last (pays fee + rent)
  tx.partialSign(adminKeypair);

  const sig = await connection.sendRawTransaction(tx.serialize());
  return sig;
}
```

#### 2) Doctor `add_prescription` (doctor + admin, admin pays)

```ts
import { Transaction } from "@solana/web3.js";

async function addPrescription({
  connection,
  program,
  adminKeypair,
  doctorKeypair,
  patientIdHash,
  rxHash,
  pointerHash,
}) {
  const ix = await program.methods
    .addPrescription(patientIdHash, rxHash, pointerHash)
    .accounts({
      admin: adminKeypair.publicKey,
      doctor: doctorKeypair.publicKey,
      doctorRole: await program.account.roleAddress(doctorKeypair.publicKey),
      patient: await program.account.patientProfileAddress(patientIdHash),
      prescription: await program.account.prescriptionAddress(patientIdHash, rxHash),
    })
    .instruction();

  const tx = new Transaction().add(ix);
  tx.feePayer = adminKeypair.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

  tx.partialSign(doctorKeypair);
  tx.partialSign(adminKeypair);

  const sig = await connection.sendRawTransaction(tx.serialize());
  return sig;
}
```

#### 3) Pharmacist `dispense_with_qr` (pharmacist + admin, admin pays)

```ts
import { Transaction } from "@solana/web3.js";

async function dispenseWithQr({
  connection,
  program,
  adminKeypair,
  pharmacistKeypair,
  qrPda,
  dispenseHash,
}) {
  const ix = await program.methods
    .dispenseWithQr(dispenseHash)
    .accounts({
      admin: adminKeypair.publicKey,
      pharmacist: pharmacistKeypair.publicKey,
      pharmacistRole: await program.account.roleAddress(pharmacistKeypair.publicKey),
      qrToken: qrPda,
      dispense: await program.account.dispenseAddress(qrPda, pharmacistKeypair.publicKey),
    })
    .instruction();

  const tx = new Transaction().add(ix);
  tx.feePayer = adminKeypair.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

  tx.partialSign(pharmacistKeypair);
  tx.partialSign(adminKeypair);

  const sig = await connection.sendRawTransaction(tx.serialize());
  return sig;
}
```

### D) Sécurité clé admin

- Stocker la clé ADMIN dans un **KMS/HSM/Vault**.
- Rotation régulière des clés avec rotation des PDA si nécessaire.
- Rate limiting des transactions.
- Audit et journalisation des opérations d’admin.

### E) UX sans blockchain

Les utilisateurs peuvent signer via des clés gérées par l’app (custodial), passkeys, ou wallets intégrés. Le backend garde la responsabilité du paiement (fee payer + rent) et l’utilisateur ne paie jamais.

---

## Build

```sh
anchor build
```

---

## Lancer le projet sur Windows (guide complet)

> Objectif: compiler le smart contract Anchor **en local** sur Windows (ou via WSL2) et tester sur un cluster local Solana.

### 1) Outils à installer

#### Option recommandée: **WSL2 + Ubuntu**

WSL2 est l’option la plus stable pour Anchor/Solana sur Windows.

1. **Activer WSL2**
   - Ouvrir PowerShell en admin:
     ```powershell
     wsl --install
     ```
   - Redémarrer, puis installer **Ubuntu** depuis le Microsoft Store.

2. **Installer Rust**
   ```bash
   curl https://sh.rustup.rs -sSf | sh
   source $HOME/.cargo/env
   ```

3. **Installer Solana CLI**
   ```bash
   sh -c "$(curl -sSfL https://release.solana.com/stable/install)"
   echo 'export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"' >> ~/.bashrc
   source ~/.bashrc
   solana --version
   ```

4. **Installer Anchor**
   ```bash
   cargo install --git https://github.com/coral-xyz/anchor avm --locked
   avm install latest
   avm use latest
   anchor --version
   ```

5. **Installer Node.js (pour les scripts/tests)**
   - Recommandé via nvm:
     ```bash
     curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
     source ~/.bashrc
     nvm install --lts
     node -v
     npm -v
     ```

#### Option alternative: **Sans WSL2 (moins stable)**

Vous pouvez tenter l’installation native sur Windows, mais Anchor et Solana sont plus fiables sous Linux.

### 2) Cloner et ouvrir le repo

```bash
cd /workspace
git clone <votre_repo> biowatchcare-repo
cd biowatchcare-repo/biowatchcare
```

### 3) Configurer Solana localnet

1. Générer un wallet admin:
   ```bash
   solana-keygen new -o ~/.config/solana/id.json
   ```

2. Lancer un validateur local:
   ```bash
   solana-test-validator
   ```

3. Dans un autre terminal:
   ```bash
   solana config set --url localhost
   solana airdrop 5
   ```

### 4) Compiler le programme Anchor

```bash
anchor build
```

### 5) Déployer sur localnet (optionnel)

```bash
anchor deploy
```

### 6) Fichiers importants

- `biowatchcare/Anchor.toml`: configuration Anchor (cluster, wallet).
- `programs/biowatchcare/src`: code du smart contract.
- `README.md`: doc backend (fee payer/admin).

### 7) Résumé rapide (checklist)

1. Installer **WSL2 + Ubuntu**
2. Installer **Rust**
3. Installer **Solana CLI**
4. Installer **Anchor (avm)**
5. Lancer `solana-test-validator`
6. `anchor build`
7. `anchor deploy` (si besoin)
