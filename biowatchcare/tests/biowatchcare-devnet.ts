/**
 * Biowatchcare – Tests d'intégration TypeScript sur Devnet Solana
 *
 * Chaque transaction est confirmée et son lien Solana Explorer est affiché.
 * Prérequis : le programme doit être déployé sur devnet à l'adresse ci-dessous.
 *   anchor deploy --provider.cluster devnet
 *
 * Lancement :
 *   npm run test:devnet
 */

import assert from "assert";
import * as anchor from "@coral-xyz/anchor";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ── Constantes ────────────────────────────────────────────────────────────────

const PROGRAM_ID = new anchor.web3.PublicKey(
  "E7BWwRFQBYXmNqqAfNPYm1ccgWysJqtJrvUSq1NTnooX"
);

const DEVNET_RPC = process.env.DEVNET_RPC_URL ?? "https://api.devnet.solana.com";
const EXPLORER   = "https://explorer.solana.com";

const CONFIG_SEED        = Buffer.from("config");
const USER_IDENTITY_SEED = Buffer.from("user_identity");
const ROLE_SEED          = Buffer.from("role");
const PATIENT_SEED       = Buffer.from("patient");
const CONSENT_SEED       = Buffer.from("consent");
const RECORD_SEED        = Buffer.from("record");
const ACCESS_EVENT_SEED  = Buffer.from("access_event");
const RX_SEED            = Buffer.from("rx");
const QR_SEED            = Buffer.from("qr");
const DISPENSE_SEED      = Buffer.from("dispense");
const INVOICE_SEED       = Buffer.from("invoice");
const CLAIM_SEED         = Buffer.from("claim");

const CONFIG_SIZE         = 121;
const ENTITY_ROLE_SIZE    = 115;
const PATIENT_SIZE        = 82;
const USER_IDENTITY_SIZE  = 91;
const CONSENT_SIZE        = 94;
const MEDICAL_RECORD_SIZE = 191;
const PRESCRIPTION_SIZE   = 146;
const QR_TOKEN_SIZE       = 122;
const DISPENSE_SIZE       = 113;
const INVOICE_SIZE        = 124;
const CLAIM_SIZE          = 85;
const ACCESS_EVENT_SIZE   = 154;
const SIGNER_FUNDING_LAMPORTS = 50_000_000;

const DEFAULT_THRESHOLD        = 75_000n;
const VIEW_RECORDS             = 1 << 0;
const VIEW_PRESCRIPTIONS       = 1 << 1;
const VIEW_INVOICES            = 1 << 2;
const VIEW_ALL                 = VIEW_RECORDS | VIEW_PRESCRIPTIONS | VIEW_INVOICES;
const QR_TOKEN_LIFETIME_SECS   = 48 * 60 * 60;

const Role          = { Hospital: 0, Insurer: 1, Doctor: 2, Pharmacist: 3 } as const;
const EntityStatus  = { Pending: 0, Approved: 1, Revoked: 2 } as const;
const PatientStatus = { Active: 0 } as const;
const RxStatus      = { Active: 0, Cancelled: 1 } as const;
const ClaimDecision = { AutoApproved: 0, Pending: 1, Approved: 2, Rejected: 3 } as const;
const UserRoleClass = { Patient: 0, Practitioner: 1, Operator: 2 } as const;
const IdentityStatus = { Active: 0, Suspended: 1 } as const;
const RecordType    = { Consultation: 0, LabResult: 1, Imaging: 2, Vaccination: 3, ClinicalNote: 4, ExternalDocument: 5 } as const;
const RecordStatus  = { Active: 0, Archived: 1, Superseded: 2 } as const;
const AccessKind    = { Read: 0, Write: 1, Share: 2, Export: 3 } as const;

// ── Helpers Explorer ──────────────────────────────────────────────────────────

function txExplorerUrl(sig: string): string {
  return `${EXPLORER}/tx/${sig}?cluster=devnet`;
}

function accountExplorerUrl(pubkey: anchor.web3.PublicKey): string {
  return `${EXPLORER}/address/${pubkey.toBase58()}?cluster=devnet`;
}

function logTx(label: string, sig: string): void {
  console.log(`\n  ✔ ${label}`);
  console.log(`    Explorer : ${txExplorerUrl(sig)}`);
}

function logAccount(label: string, pubkey: anchor.web3.PublicKey): void {
  console.log(`    Account  [${label}] : ${accountExplorerUrl(pubkey)}`);
}

// ── Keypair helpers ───────────────────────────────────────────────────────────

function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

function loadKeypairIfExists(kpPath: string | undefined): anchor.web3.Keypair | null {
  if (!kpPath) return null;
  const full = expandHome(kpPath);
  if (!fs.existsSync(full)) return null;
  return anchor.web3.Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(full, "utf8")) as number[])
  );
}

async function getPayer(connection: anchor.web3.Connection): Promise<anchor.web3.Keypair> {
  for (const candidate of [
    process.env.ANCHOR_WALLET,
    path.join(os.homedir(), ".config", "solana", "id.json"),
  ]) {
    const kp = loadKeypairIfExists(candidate);
    if (kp) {
      const balance = await connection.getBalance(kp.publicKey);
      if (balance > 0) return kp;
    }
  }
  throw new Error(
    "No funded wallet found. Set ANCHOR_WALLET to a funded devnet keypair before running this test."
  );
}

async function fundWithPayer(
  connection: anchor.web3.Connection,
  payer: anchor.web3.Keypair,
  pubkey: anchor.web3.PublicKey,
  lamports = SIGNER_FUNDING_LAMPORTS
): Promise<void> {
  if (payer.publicKey.equals(pubkey)) {
    return;
  }
  const currentBalance = await connection.getBalance(pubkey, "confirmed");
  if (currentBalance >= lamports) {
    return;
  }
  const missingLamports = lamports - currentBalance;
  const tx = new anchor.web3.Transaction().add(
    anchor.web3.SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: pubkey,
      lamports: missingLamports,
    })
  );
  const sig = await anchor.web3.sendAndConfirmTransaction(connection, tx, [payer], {
    commitment: "confirmed",
  });
  console.log(`    Financement wallet de test : ${txExplorerUrl(sig)}`);
}

// ── Encodeurs d'instructions ──────────────────────────────────────────────────

function discriminator(name: string): Buffer {
  return Buffer.from(
    crypto.createHash("sha256").update(`global:${name}`).digest()
  ).subarray(0, 8);
}

function encodeInitializeConfig(threshold: bigint): Buffer {
  const disc = discriminator("initialize_config");
  const data = Buffer.alloc(1 + 8);
  data.writeUInt8(1, 0);
  data.writeBigUInt64LE(threshold, 1);
  return Buffer.concat([disc, data]);
}

function encodeSetThreshold(threshold: bigint): Buffer {
  const disc = discriminator("set_threshold");
  const data = Buffer.alloc(8);
  data.writeBigUInt64LE(threshold, 0);
  return Buffer.concat([disc, data]);
}

function encodeProposeAdminTransfer(newAdminPubkey: anchor.web3.PublicKey): Buffer {
  return Buffer.concat([discriminator("propose_admin_transfer"), newAdminPubkey.toBuffer()]);
}

function encodeRegisterEntity(role: number, entityPubkey: anchor.web3.PublicKey, metadataHash: Buffer): Buffer {
  const disc = discriminator("register_entity");
  const data = Buffer.alloc(1 + 32 + 32);
  data.writeUInt8(role, 0);
  entityPubkey.toBuffer().copy(data, 1);
  metadataHash.copy(data, 33);
  return Buffer.concat([disc, data]);
}

function encodeCreatePatientProfile(patientIdHash: Buffer): Buffer {
  return Buffer.concat([discriminator("create_patient_profile"), patientIdHash]);
}

function encodeRegisterUserIdentity(
  appUserIdHash: Buffer,
  walletPubkey: anchor.web3.PublicKey,
  roleClass: number
): Buffer {
  const disc = discriminator("register_user_identity");
  const data = Buffer.alloc(32 + 32 + 1);
  appUserIdHash.copy(data, 0);
  walletPubkey.toBuffer().copy(data, 32);
  data.writeUInt8(roleClass, 64);
  return Buffer.concat([disc, data]);
}

function encodeGrantConsent(
  patientIdHash: Buffer,
  granteePubkey: anchor.web3.PublicKey,
  scopes: number,
  expiresAt: number
): Buffer {
  const disc = discriminator("grant_consent");
  const data = Buffer.alloc(32 + 32 + 4 + 8);
  patientIdHash.copy(data, 0);
  granteePubkey.toBuffer().copy(data, 32);
  data.writeUInt32LE(scopes, 64);
  data.writeBigInt64LE(BigInt(expiresAt), 68);
  return Buffer.concat([disc, data]);
}

function encodeUpdateConsent(
  patientIdHash: Buffer,
  granteePubkey: anchor.web3.PublicKey,
  scopes: number,
  expiresAt: number
): Buffer {
  const disc = discriminator("update_consent");
  const data = Buffer.alloc(32 + 32 + 4 + 8);
  patientIdHash.copy(data, 0);
  granteePubkey.toBuffer().copy(data, 32);
  data.writeUInt32LE(scopes, 64);
  data.writeBigInt64LE(BigInt(expiresAt), 68);
  return Buffer.concat([disc, data]);
}

function encodeRevokeConsent(patientIdHash: Buffer, granteePubkey: anchor.web3.PublicKey): Buffer {
  const disc = discriminator("revoke_consent");
  const data = Buffer.alloc(32 + 32);
  patientIdHash.copy(data, 0);
  granteePubkey.toBuffer().copy(data, 32);
  return Buffer.concat([disc, data]);
}

function encodeAddPrescription(patientIdHash: Buffer, rxHash: Buffer, pointerHash: Buffer): Buffer {
  return Buffer.concat([discriminator("add_prescription"), patientIdHash, rxHash, pointerHash]);
}

function encodeAddMedicalRecordAnchor(
  patientIdHash: Buffer,
  recordType: number,
  recordHash: Buffer,
  pointerHash: Buffer,
  version: number
): Buffer {
  const disc = discriminator("add_medical_record_anchor");
  const data = Buffer.alloc(32 + 1 + 32 + 32 + 4);
  patientIdHash.copy(data, 0);
  data.writeUInt8(recordType, 32);
  recordHash.copy(data, 33);
  pointerHash.copy(data, 65);
  data.writeUInt32LE(version, 97);
  return Buffer.concat([disc, data]);
}

function encodeSupersedeMedicalRecord(supersededBy: anchor.web3.PublicKey): Buffer {
  return Buffer.concat([discriminator("supersede_medical_record"), supersededBy.toBuffer()]);
}

function encodeLogAccessEvent(
  patientIdHash: Buffer,
  accessKind: number,
  resourceHash: Buffer,
  nonce: number
): Buffer {
  const disc = discriminator("log_access_event");
  const data = Buffer.alloc(32 + 1 + 32 + 8);
  patientIdHash.copy(data, 0);
  data.writeUInt8(accessKind, 32);
  resourceHash.copy(data, 33);
  data.writeBigUInt64LE(BigInt(nonce), 65);
  return Buffer.concat([disc, data]);
}

function encodeIssueQrToken(tokenHash: Buffer): Buffer {
  return Buffer.concat([discriminator("issue_qr_token"), tokenHash]);
}

function encodeDispenseWithQr(dispenseHash: Buffer): Buffer {
  return Buffer.concat([discriminator("dispense_with_qr"), dispenseHash]);
}

function encodeCreateInvoice(
  patientIdHash: Buffer,
  invoiceHash: Buffer,
  amount: bigint,
  currencyCode: string
): Buffer {
  const disc = discriminator("create_invoice");
  const data = Buffer.alloc(32 + 32 + 8 + 3);
  patientIdHash.copy(data, 0);
  invoiceHash.copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  Buffer.from(currencyCode, "ascii").copy(data, 72);
  return Buffer.concat([disc, data]);
}

function encodeAutoOrPendingClaim(insurerPubkey: anchor.web3.PublicKey): Buffer {
  return Buffer.concat([discriminator("auto_or_pending_claim"), insurerPubkey.toBuffer()]);
}

function encodeInsurerDecideClaim(approve: boolean, reasonCode: number): Buffer {
  const disc = discriminator("insurer_decide_claim");
  const data = Buffer.alloc(1 + 2);
  data.writeUInt8(approve ? 1 : 0, 0);
  data.writeUInt16LE(reasonCode, 1);
  return Buffer.concat([disc, data]);
}

function encodeNoArgs(name: string): Buffer {
  return discriminator(name);
}

// ── PDA helpers ───────────────────────────────────────────────────────────────

function readPubkey(data: Buffer, offset: number): anchor.web3.PublicKey {
  return new anchor.web3.PublicKey(data.slice(offset, offset + 32));
}

function readI64(data: Buffer, offset: number): number {
  return Number(data.readBigInt64LE(offset));
}

const getConfigPda = (): anchor.web3.PublicKey =>
  anchor.web3.PublicKey.findProgramAddressSync([CONFIG_SEED], PROGRAM_ID)[0];

const getRolePda = (entityPubkey: anchor.web3.PublicKey): anchor.web3.PublicKey =>
  anchor.web3.PublicKey.findProgramAddressSync([ROLE_SEED, entityPubkey.toBuffer()], PROGRAM_ID)[0];

const getUserIdentityPda = (appUserIdHash: Buffer): anchor.web3.PublicKey =>
  anchor.web3.PublicKey.findProgramAddressSync([USER_IDENTITY_SEED, appUserIdHash], PROGRAM_ID)[0];

const getPatientPda = (patientIdHash: Buffer): anchor.web3.PublicKey =>
  anchor.web3.PublicKey.findProgramAddressSync([PATIENT_SEED, patientIdHash], PROGRAM_ID)[0];

const getConsentPda = (
  patientPda: anchor.web3.PublicKey,
  granteePubkey: anchor.web3.PublicKey
): anchor.web3.PublicKey =>
  anchor.web3.PublicKey.findProgramAddressSync(
    [CONSENT_SEED, patientPda.toBuffer(), granteePubkey.toBuffer()], PROGRAM_ID
  )[0];

const getMedicalRecordPda = (
  patientPda: anchor.web3.PublicKey,
  recordHash: Buffer
): anchor.web3.PublicKey =>
  anchor.web3.PublicKey.findProgramAddressSync(
    [RECORD_SEED, patientPda.toBuffer(), recordHash], PROGRAM_ID
  )[0];

const getAccessEventPda = (
  patientPda: anchor.web3.PublicKey,
  accessorPubkey: anchor.web3.PublicKey,
  resourceHash: Buffer,
  nonce: number
): anchor.web3.PublicKey => {
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(BigInt(nonce));
  return anchor.web3.PublicKey.findProgramAddressSync(
    [ACCESS_EVENT_SEED, patientPda.toBuffer(), accessorPubkey.toBuffer(), resourceHash, nonceBuf],
    PROGRAM_ID
  )[0];
};

const getPrescriptionPda = (
  patientPda: anchor.web3.PublicKey,
  rxHash: Buffer
): anchor.web3.PublicKey =>
  anchor.web3.PublicKey.findProgramAddressSync(
    [RX_SEED, patientPda.toBuffer(), rxHash], PROGRAM_ID
  )[0];

const getQrPda = (
  prescriptionPda: anchor.web3.PublicKey,
  tokenHash: Buffer
): anchor.web3.PublicKey =>
  anchor.web3.PublicKey.findProgramAddressSync(
    [QR_SEED, prescriptionPda.toBuffer(), tokenHash], PROGRAM_ID
  )[0];

const getDispensePda = (
  prescriptionPda: anchor.web3.PublicKey,
  pharmacistPubkey: anchor.web3.PublicKey
): anchor.web3.PublicKey =>
  anchor.web3.PublicKey.findProgramAddressSync(
    [DISPENSE_SEED, prescriptionPda.toBuffer(), pharmacistPubkey.toBuffer()], PROGRAM_ID
  )[0];

const getInvoicePda = (
  patientPda: anchor.web3.PublicKey,
  invoiceHash: Buffer
): anchor.web3.PublicKey =>
  anchor.web3.PublicKey.findProgramAddressSync(
    [INVOICE_SEED, patientPda.toBuffer(), invoiceHash], PROGRAM_ID
  )[0];

const getClaimPda = (
  invoicePda: anchor.web3.PublicKey,
  insurerPubkey: anchor.web3.PublicKey
): anchor.web3.PublicKey =>
  anchor.web3.PublicKey.findProgramAddressSync(
    [CLAIM_SEED, invoicePda.toBuffer(), insurerPubkey.toBuffer()], PROGRAM_ID
  )[0];

// ── Transaction helper ────────────────────────────────────────────────────────

async function sendIx(
  connection: anchor.web3.Connection,
  instructions: anchor.web3.TransactionInstruction[],
  signers: anchor.web3.Keypair[],
  feePayer: anchor.web3.PublicKey,
  label: string
): Promise<string> {
  const tx = new anchor.web3.Transaction();
  for (const ix of instructions) tx.add(ix);
  tx.feePayer = feePayer;
  const sig = await anchor.web3.sendAndConfirmTransaction(connection, tx, signers, {
    commitment: "confirmed",
  });
  logTx(label, sig);
  return sig;
}

// ── Helpers partagés ──────────────────────────────────────────────────────────

interface EntityContext {
  entity: anchor.web3.Keypair;
  rolePda: anchor.web3.PublicKey;
}

interface PatientContext {
  patientIdHash: Buffer;
  patientPda:    anchor.web3.PublicKey;
}

async function registerAndApproveEntity(
  connection: anchor.web3.Connection,
  payer: anchor.web3.Keypair,
  configPda: anchor.web3.PublicKey,
  role: number,
  roleLabel: string
): Promise<EntityContext> {
  const entity = anchor.web3.Keypair.generate();
  await fundWithPayer(connection, payer, entity.publicKey);

  const rolePda      = getRolePda(entity.publicKey);
  const metadataHash = crypto.randomBytes(32);

  const registerIx = new anchor.web3.TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey,                        isSigner: true,  isWritable: true  },
      { pubkey: configPda,                              isSigner: false, isWritable: false },
      { pubkey: rolePda,                                isSigner: false, isWritable: true  },
      { pubkey: anchor.web3.SystemProgram.programId,    isSigner: false, isWritable: false },
    ],
    data: encodeRegisterEntity(role, entity.publicKey, metadataHash),
  });

  const approveIx = new anchor.web3.TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey,  isSigner: true,  isWritable: true  },
      { pubkey: configPda,        isSigner: false, isWritable: false },
      { pubkey: rolePda,          isSigner: false, isWritable: true  },
    ],
    data: encodeNoArgs("approve_entity"),
  });

  await sendIx(
    connection, [registerIx, approveIx], [payer], payer.publicKey,
    `register_entity + approve_entity (${roleLabel})`
  );
  logAccount(`role/${roleLabel}`, rolePda);

  const roleInfo = await connection.getAccountInfo(rolePda);
  assert(roleInfo, "role account not found");
  assert.strictEqual(roleInfo.data.length, ENTITY_ROLE_SIZE);
  assert(readPubkey(roleInfo.data as Buffer, 8).equals(entity.publicKey));
  assert.strictEqual(roleInfo.data.readUInt8(40), role);
  assert.strictEqual(roleInfo.data.readUInt8(41), EntityStatus.Approved);

  return { entity, rolePda };
}

async function createPatientProfile(
  connection: anchor.web3.Connection,
  staff: EntityContext
): Promise<PatientContext> {
  const patientIdHash = crypto.randomBytes(32);
  const patientPda    = getPatientPda(patientIdHash);

  const ix = new anchor.web3.TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: staff.entity.publicKey,              isSigner: true,  isWritable: true  },
      { pubkey: getConfigPda(),                      isSigner: false, isWritable: false },
      { pubkey: staff.rolePda,                       isSigner: false, isWritable: false },
      { pubkey: patientPda,                          isSigner: false, isWritable: true  },
      { pubkey: anchor.web3.SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: encodeCreatePatientProfile(patientIdHash),
  });

  await sendIx(connection, [ix], [staff.entity], staff.entity.publicKey, "create_patient_profile");
  logAccount("patient", patientPda);

  const patientInfo = await connection.getAccountInfo(patientPda);
  assert(patientInfo, "patient account not found");
  assert.strictEqual(patientInfo.data.length, PATIENT_SIZE);
  assert.deepStrictEqual((patientInfo.data as Buffer).slice(8, 40), patientIdHash);
  assert.strictEqual(patientInfo.data.readUInt8(40), PatientStatus.Active);

  return { patientIdHash, patientPda };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("biowatchcare – devnet", function () {
  // Délais généreux : devnet est plus lent que localnet
  this.timeout(120_000);

  let connection: anchor.web3.Connection;
  let payer: anchor.web3.Keypair;
  let configPda: anchor.web3.PublicKey;

  before(async () => {
    connection = new anchor.web3.Connection(DEVNET_RPC, {
      commitment: "confirmed",
      confirmTransactionInitialTimeout: 60_000,
    });
    payer     = await getPayer(connection);
    configPda = getConfigPda();

    console.log(`\n  Admin wallet : ${payer.publicKey.toBase58()}`);
    console.log(`  ${accountExplorerUrl(payer.publicKey)}`);
    console.log(`  Config PDA   : ${configPda.toBase58()}`);
    console.log(`  ${accountExplorerUrl(configPda)}`);

    // Initialise la config si elle n'existe pas encore
    const configInfo = await connection.getAccountInfo(configPda);
    if (!configInfo) {
      const ix = new anchor.web3.TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: payer.publicKey,                        isSigner: true,  isWritable: true  },
          { pubkey: configPda,                              isSigner: false, isWritable: true  },
          { pubkey: anchor.web3.SystemProgram.programId,    isSigner: false, isWritable: false },
        ],
        data: encodeInitializeConfig(DEFAULT_THRESHOLD),
      });
      await sendIx(connection, [ix], [payer], payer.publicKey, "initialize_config (première fois)");
    }

    // Remet le threshold à la valeur de base avant chaque suite
    const setThresholdIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true,  isWritable: true  },
        { pubkey: configPda,       isSigner: false, isWritable: true  },
      ],
      data: encodeSetThreshold(DEFAULT_THRESHOLD),
    });
    await sendIx(connection, [setThresholdIx], [payer], payer.publicKey, "set_threshold (reset avant tests)");
  });

  // ── 1. Config & threshold ─────────────────────────────────────────────────

  it("1 – vérifie la config PDA et met à jour le threshold", async () => {
    const configInfo = await connection.getAccountInfo(configPda);
    assert(configInfo, "config account not found");
    assert.strictEqual(configInfo.data.length, CONFIG_SIZE);
    assert(readPubkey(configInfo.data as Buffer, 8).equals(payer.publicKey));
    assert.strictEqual((configInfo.data as Buffer).readBigUInt64LE(40), DEFAULT_THRESHOLD);

    const newThreshold = DEFAULT_THRESHOLD + 123n;
    const ix = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true,  isWritable: true  },
        { pubkey: configPda,       isSigner: false, isWritable: true  },
      ],
      data: encodeSetThreshold(newThreshold),
    });
    await sendIx(connection, [ix], [payer], payer.publicKey, `set_threshold → ${newThreshold}`);

    const updated = await connection.getAccountInfo(configPda);
    assert.strictEqual((updated!.data as Buffer).readBigUInt64LE(40), newThreshold);

    // Restaure
    const restoreIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true,  isWritable: true  },
        { pubkey: configPda,       isSigner: false, isWritable: true  },
      ],
      data: encodeSetThreshold(DEFAULT_THRESHOLD),
    });
    await sendIx(connection, [restoreIx], [payer], payer.publicKey, `set_threshold → ${DEFAULT_THRESHOLD} (restauration)`);
  });

  // ── 2. Transfert admin 2-étapes ───────────────────────────────────────────

  it("2 – transfert admin 2-étapes : propose → accepte → restaure", async () => {
    const newAdmin = anchor.web3.Keypair.generate();
    await fundWithPayer(connection, payer, newAdmin.publicKey);
    console.log(`\n    Nouveau admin temporaire : ${newAdmin.publicKey.toBase58()}`);

    // Étape 1 : propose
    const proposeIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true,  isWritable: true  },
        { pubkey: configPda,       isSigner: false, isWritable: true  },
      ],
      data: encodeProposeAdminTransfer(newAdmin.publicKey),
    });
    await sendIx(connection, [proposeIx], [payer], payer.publicKey, "propose_admin_transfer");

    let info = await connection.getAccountInfo(configPda);
    assert(readPubkey(info!.data as Buffer, 57).equals(newAdmin.publicKey), "pending_admin mismatch");

    // Étape 2 : accepte
    const acceptIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: newAdmin.publicKey, isSigner: true,  isWritable: true  },
        { pubkey: configPda,          isSigner: false, isWritable: true  },
      ],
      data: encodeNoArgs("accept_admin_transfer"),
    });
    await sendIx(connection, [acceptIx], [newAdmin], newAdmin.publicKey, "accept_admin_transfer");

    info = await connection.getAccountInfo(configPda);
    assert(readPubkey(info!.data as Buffer, 8).equals(newAdmin.publicKey), "admin non mis à jour");

    // Restaure : newAdmin propose → payer accepte
    const restoreIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: newAdmin.publicKey, isSigner: true,  isWritable: true  },
        { pubkey: configPda,          isSigner: false, isWritable: true  },
      ],
      data: encodeProposeAdminTransfer(payer.publicKey),
    });
    await sendIx(connection, [restoreIx], [newAdmin], newAdmin.publicKey, "propose_admin_transfer (restauration)");

    const acceptBackIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true,  isWritable: true  },
        { pubkey: configPda,       isSigner: false, isWritable: true  },
      ],
      data: encodeNoArgs("accept_admin_transfer"),
    });
    await sendIx(connection, [acceptBackIx], [payer], payer.publicKey, "accept_admin_transfer (restauration)");

    info = await connection.getAccountInfo(configPda);
    assert(readPubkey(info!.data as Buffer, 8).equals(payer.publicKey), "admin non restauré");
  });

  // ── 3. Cycle de vie rôle entité ────────────────────────────────────────────

  it("3 – register → approve → revoke d'un rôle entité (Docteur)", async () => {
    const entity  = anchor.web3.Keypair.generate();
    const rolePda = getRolePda(entity.publicKey);
    console.log(`\n    Entité : ${entity.publicKey.toBase58()}`);
    logAccount("role/doctor", rolePda);

    const registerIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey,                     isSigner: true,  isWritable: true  },
        { pubkey: configPda,                           isSigner: false, isWritable: false },
        { pubkey: rolePda,                             isSigner: false, isWritable: true  },
        { pubkey: anchor.web3.SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: encodeRegisterEntity(Role.Doctor, entity.publicKey, crypto.randomBytes(32)),
    });
    await sendIx(connection, [registerIx], [payer], payer.publicKey, "register_entity (Doctor)");

    let roleInfo = await connection.getAccountInfo(rolePda);
    assert(roleInfo, "role account not found");
    assert.strictEqual(roleInfo.data.readUInt8(40), Role.Doctor);
    assert.strictEqual(roleInfo.data.readUInt8(41), EntityStatus.Pending);

    const approveIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true,  isWritable: true  },
        { pubkey: configPda,       isSigner: false, isWritable: false },
        { pubkey: rolePda,         isSigner: false, isWritable: true  },
      ],
      data: encodeNoArgs("approve_entity"),
    });
    await sendIx(connection, [approveIx], [payer], payer.publicKey, "approve_entity");
    roleInfo = await connection.getAccountInfo(rolePda);
    assert.strictEqual(roleInfo!.data.readUInt8(41), EntityStatus.Approved);

    const revokeIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true,  isWritable: true  },
        { pubkey: configPda,       isSigner: false, isWritable: false },
        { pubkey: rolePda,         isSigner: false, isWritable: true  },
      ],
      data: encodeNoArgs("revoke_entity"),
    });
    await sendIx(connection, [revokeIx], [payer], payer.publicKey, "revoke_entity");
    roleInfo = await connection.getAccountInfo(rolePda);
    assert.strictEqual(roleInfo!.data.readUInt8(41), EntityStatus.Revoked);
  });

  // ── 4. Profil patient & consentement ──────────────────────────────────────

  it("4 – profil patient + grant/update/revoke/réactiver consentement", async () => {
    const hospital = await registerAndApproveEntity(connection, payer, configPda, Role.Hospital, "Hospital");
    const patient  = await createPatientProfile(connection, hospital);

    const patientSigner = anchor.web3.Keypair.generate();
    await fundWithPayer(connection, payer, patientSigner.publicKey);

    const consentPda = getConsentPda(patient.patientPda, hospital.entity.publicKey);
    const expiresAt  = Math.floor(Date.now() / 1000) + 3600;
    logAccount("consent", consentPda);

    // grant_consent
    const grantIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: patientSigner.publicKey,             isSigner: true,  isWritable: true  },
        { pubkey: patient.patientPda,                  isSigner: false, isWritable: false },
        { pubkey: consentPda,                          isSigner: false, isWritable: true  },
        { pubkey: anchor.web3.SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: encodeGrantConsent(patient.patientIdHash, hospital.entity.publicKey, VIEW_ALL, expiresAt),
    });
    await sendIx(connection, [grantIx], [patientSigner], patientSigner.publicKey, "grant_consent (VIEW_ALL)");

    let consentInfo = await connection.getAccountInfo(consentPda);
    assert(consentInfo, "consent account not found");
    assert.strictEqual(consentInfo.data.length, CONSENT_SIZE);
    assert.strictEqual((consentInfo.data as Buffer).readUInt32LE(72), VIEW_ALL);
    assert.strictEqual((consentInfo.data as Buffer).readUInt8(84), 0); // revoked = false

    // update_consent
    const updateIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: patientSigner.publicKey, isSigner: true,  isWritable: true  },
        { pubkey: patient.patientPda,      isSigner: false, isWritable: false },
        { pubkey: consentPda,              isSigner: false, isWritable: true  },
      ],
      data: encodeUpdateConsent(patient.patientIdHash, hospital.entity.publicKey, VIEW_RECORDS, expiresAt + 7200),
    });
    await sendIx(connection, [updateIx], [patientSigner], patientSigner.publicKey, "update_consent (VIEW_RECORDS)");
    consentInfo = await connection.getAccountInfo(consentPda);
    assert.strictEqual((consentInfo!.data as Buffer).readUInt32LE(72), VIEW_RECORDS);

    // revoke_consent
    const revokeIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: patientSigner.publicKey, isSigner: true,  isWritable: true  },
        { pubkey: patient.patientPda,      isSigner: false, isWritable: false },
        { pubkey: consentPda,              isSigner: false, isWritable: true  },
      ],
      data: encodeRevokeConsent(patient.patientIdHash, hospital.entity.publicKey),
    });
    await sendIx(connection, [revokeIx], [patientSigner], patientSigner.publicKey, "revoke_consent");
    consentInfo = await connection.getAccountInfo(consentPda);
    assert.strictEqual((consentInfo!.data as Buffer).readUInt8(84), 1); // revoked = true

    // update_consent après révocation → réinitialise le flag
    const reactivateIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: patientSigner.publicKey, isSigner: true,  isWritable: true  },
        { pubkey: patient.patientPda,      isSigner: false, isWritable: false },
        { pubkey: consentPda,              isSigner: false, isWritable: true  },
      ],
      data: encodeUpdateConsent(patient.patientIdHash, hospital.entity.publicKey, VIEW_ALL, expiresAt),
    });
    await sendIx(connection, [reactivateIx], [patientSigner], patientSigner.publicKey, "update_consent (réactivation)");
    consentInfo = await connection.getAccountInfo(consentPda);
    assert.strictEqual((consentInfo!.data as Buffer).readUInt8(84), 0); // revoked = false
  });

  // ── 5. Prescription, QR, dispensation ─────────────────────────────────────

  it("5 – prescription, émission QR, vérification, dispensation, annulation", async () => {
    const hospital   = await registerAndApproveEntity(connection, payer, configPda, Role.Hospital,    "Hospital");
    const doctor     = await registerAndApproveEntity(connection, payer, configPda, Role.Doctor,      "Doctor");
    const pharmacist = await registerAndApproveEntity(connection, payer, configPda, Role.Pharmacist,  "Pharmacist");
    const patient    = await createPatientProfile(connection, hospital);

    const rxHash          = crypto.randomBytes(32);
    const pointerHash     = crypto.randomBytes(32);
    const prescriptionPda = getPrescriptionPda(patient.patientPda, rxHash);
    logAccount("prescription", prescriptionPda);

    // add_prescription
    const addRxIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: doctor.entity.publicKey,             isSigner: true,  isWritable: true  },
        { pubkey: doctor.rolePda,                      isSigner: false, isWritable: false },
        { pubkey: patient.patientPda,                  isSigner: false, isWritable: false },
        { pubkey: prescriptionPda,                     isSigner: false, isWritable: true  },
        { pubkey: anchor.web3.SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: encodeAddPrescription(patient.patientIdHash, rxHash, pointerHash),
    });
    await sendIx(connection, [addRxIx], [doctor.entity], doctor.entity.publicKey, "add_prescription");

    let prescriptionInfo = await connection.getAccountInfo(prescriptionPda);
    assert(prescriptionInfo, "prescription account not found");
    assert.strictEqual(prescriptionInfo.data.length, PRESCRIPTION_SIZE);
    assert.strictEqual(prescriptionInfo.data.readUInt8(144), RxStatus.Active);

    // issue_qr_token
    const tokenHash = crypto.randomBytes(32);
    const qrPda     = getQrPda(prescriptionPda, tokenHash);
    logAccount("qr_token", qrPda);

    const issueQrIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: doctor.entity.publicKey,             isSigner: true,  isWritable: true  },
        { pubkey: doctor.rolePda,                      isSigner: false, isWritable: false },
        { pubkey: prescriptionPda,                     isSigner: false, isWritable: true  },
        { pubkey: qrPda,                               isSigner: false, isWritable: true  },
        { pubkey: anchor.web3.SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: encodeIssueQrToken(tokenHash),
    });
    await sendIx(connection, [issueQrIx], [doctor.entity], doctor.entity.publicKey, "issue_qr_token");

    let qrInfo = await connection.getAccountInfo(qrPda);
    assert(qrInfo, "qr token account not found");
    assert.strictEqual(qrInfo.data.length, QR_TOKEN_SIZE);
    const expiresAt = readI64(qrInfo.data as Buffer, 72);
    const now = Math.floor(Date.now() / 1000);
    assert(expiresAt > now);
    assert(expiresAt <= now + QR_TOKEN_LIFETIME_SECS + 60);
    assert.strictEqual(qrInfo.data.readUInt8(80), 0); // used = false

    // verify_qr_token (pharmacist)
    const verifyQrIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: pharmacist.entity.publicKey, isSigner: true,  isWritable: true  },
        { pubkey: pharmacist.rolePda,          isSigner: false, isWritable: false },
        { pubkey: qrPda,                       isSigner: false, isWritable: false },
      ],
      data: encodeNoArgs("verify_qr_token"),
    });
    await sendIx(connection, [verifyQrIx], [pharmacist.entity], pharmacist.entity.publicKey, "verify_qr_token");

    // dispense_with_qr
    const dispenseHash = crypto.randomBytes(32);
    const dispensePda  = getDispensePda(prescriptionPda, pharmacist.entity.publicKey);
    logAccount("dispense", dispensePda);

    const dispenseIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: pharmacist.entity.publicKey,         isSigner: true,  isWritable: true  },
        { pubkey: pharmacist.rolePda,                  isSigner: false, isWritable: false },
        { pubkey: qrPda,                               isSigner: false, isWritable: true  },
        { pubkey: dispensePda,                         isSigner: false, isWritable: true  },
        { pubkey: anchor.web3.SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: encodeDispenseWithQr(dispenseHash),
    });
    await sendIx(connection, [dispenseIx], [pharmacist.entity], pharmacist.entity.publicKey, "dispense_with_qr");

    qrInfo = await connection.getAccountInfo(qrPda);
    assert.strictEqual(qrInfo!.data.readUInt8(80), 1); // used = true

    const dispenseInfo = await connection.getAccountInfo(dispensePda);
    assert(dispenseInfo, "dispense account not found");
    assert.strictEqual(dispenseInfo.data.length, DISPENSE_SIZE);

    // Double-verify doit échouer (QrAlreadyUsed)
    await assert.rejects(
      anchor.web3.sendAndConfirmTransaction(
        connection,
        new anchor.web3.Transaction().add(verifyQrIx),
        [pharmacist.entity],
        { commitment: "confirmed" }
      ),
      /QrAlreadyUsed|custom program error|SendTransactionError/
    );
    console.log("    ✔ verify_qr_token sur QR déjà utilisé → erreur attendue ✓");

    // Prescription annulée (dans la même tx)
    const cancelledRxHash  = crypto.randomBytes(32);
    const cancelledPtr     = crypto.randomBytes(32);
    const cancelledPda     = getPrescriptionPda(patient.patientPda, cancelledRxHash);

    const addCancelledIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: doctor.entity.publicKey,             isSigner: true,  isWritable: true  },
        { pubkey: doctor.rolePda,                      isSigner: false, isWritable: false },
        { pubkey: patient.patientPda,                  isSigner: false, isWritable: false },
        { pubkey: cancelledPda,                        isSigner: false, isWritable: true  },
        { pubkey: anchor.web3.SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: encodeAddPrescription(patient.patientIdHash, cancelledRxHash, cancelledPtr),
    });
    const cancelIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: doctor.entity.publicKey, isSigner: true,  isWritable: true  },
        { pubkey: doctor.rolePda,          isSigner: false, isWritable: false },
        { pubkey: cancelledPda,            isSigner: false, isWritable: true  },
      ],
      data: encodeNoArgs("cancel_prescription"),
    });
    await sendIx(
      connection, [addCancelledIx, cancelIx], [doctor.entity], doctor.entity.publicKey,
      "add_prescription + cancel_prescription"
    );
    logAccount("prescription_cancelled", cancelledPda);

    prescriptionInfo = await connection.getAccountInfo(cancelledPda);
    assert.strictEqual(prescriptionInfo!.data.readUInt8(144), RxStatus.Cancelled);
  });

  // ── 6. Factures & remboursements ──────────────────────────────────────────

  it("6 – factures : remboursement auto, approuvé, rejeté", async () => {
    const hospital = await registerAndApproveEntity(connection, payer, configPda, Role.Hospital, "Hospital");
    const insurer  = await registerAndApproveEntity(connection, payer, configPda, Role.Insurer,  "Insurer");
    const patient  = await createPatientProfile(connection, hospital);

    const mkInvoice = async (invoiceHash: Buffer, amount: bigint, currency: string) => {
      const invoicePda = getInvoicePda(patient.patientPda, invoiceHash);
      const ix = new anchor.web3.TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: hospital.entity.publicKey,           isSigner: true,  isWritable: true  },
          { pubkey: hospital.rolePda,                    isSigner: false, isWritable: false },
          { pubkey: patient.patientPda,                  isSigner: false, isWritable: false },
          { pubkey: invoicePda,                          isSigner: false, isWritable: true  },
          { pubkey: anchor.web3.SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: encodeCreateInvoice(patient.patientIdHash, invoiceHash, amount, currency),
      });
      await sendIx(connection, [ix], [hospital.entity], hospital.entity.publicKey,
        `create_invoice (${currency} ${amount})`);
      logAccount(`invoice/${currency}`, invoicePda);
      return invoicePda;
    };

    const mkClaim = async (invoicePda: anchor.web3.PublicKey, claimPda: anchor.web3.PublicKey) => {
      const ix = new anchor.web3.TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: hospital.entity.publicKey,           isSigner: true,  isWritable: true  },
          { pubkey: hospital.rolePda,                    isSigner: false, isWritable: false },
          { pubkey: configPda,                           isSigner: false, isWritable: false },
          { pubkey: invoicePda,                          isSigner: false, isWritable: true  },
          { pubkey: claimPda,                            isSigner: false, isWritable: true  },
          { pubkey: insurer.entity.publicKey,            isSigner: false, isWritable: false },
          { pubkey: anchor.web3.SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: encodeAutoOrPendingClaim(insurer.entity.publicKey),
      });
      await sendIx(connection, [ix], [hospital.entity], hospital.entity.publicKey, "auto_or_pending_claim");
      logAccount("claim", claimPda);
    };

    // Remboursement automatique (montant <= seuil)
    const autoHash    = crypto.randomBytes(32);
    const autoInvoice = await mkInvoice(autoHash, DEFAULT_THRESHOLD - 1n, "XAF");
    const autoClaim   = getClaimPda(autoInvoice, insurer.entity.publicKey);
    await mkClaim(autoInvoice, autoClaim);

    let claimInfo = await connection.getAccountInfo(autoClaim);
    assert(claimInfo, "auto claim not found");
    assert.strictEqual(claimInfo.data.length, CLAIM_SIZE);
    assert.strictEqual(claimInfo.data.readUInt8(72), ClaimDecision.AutoApproved);

    // Remboursement en attente → approuvé
    const pendingHash    = crypto.randomBytes(32);
    const pendingInvoice = await mkInvoice(pendingHash, DEFAULT_THRESHOLD + 1000n, "EUR");
    const pendingClaim   = getClaimPda(pendingInvoice, insurer.entity.publicKey);
    await mkClaim(pendingInvoice, pendingClaim);

    claimInfo = await connection.getAccountInfo(pendingClaim);
    assert.strictEqual(claimInfo!.data.readUInt8(72), ClaimDecision.Pending);

    const approveIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: insurer.entity.publicKey, isSigner: true,  isWritable: true  },
        { pubkey: insurer.rolePda,          isSigner: false, isWritable: false },
        { pubkey: pendingInvoice,           isSigner: false, isWritable: true  },
        { pubkey: pendingClaim,             isSigner: false, isWritable: true  },
      ],
      data: encodeInsurerDecideClaim(true, 0),
    });
    await sendIx(connection, [approveIx], [insurer.entity], insurer.entity.publicKey, "insurer_decide_claim (approuvé)");
    claimInfo = await connection.getAccountInfo(pendingClaim);
    assert.strictEqual(claimInfo!.data.readUInt8(72), ClaimDecision.Approved);

    // Remboursement en attente → rejeté
    const rejectHash    = crypto.randomBytes(32);
    const rejectInvoice = await mkInvoice(rejectHash, DEFAULT_THRESHOLD + 5000n, "USD");
    const rejectClaim   = getClaimPda(rejectInvoice, insurer.entity.publicKey);
    await mkClaim(rejectInvoice, rejectClaim);

    const rejectIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: insurer.entity.publicKey, isSigner: true,  isWritable: true  },
        { pubkey: insurer.rolePda,          isSigner: false, isWritable: false },
        { pubkey: rejectInvoice,            isSigner: false, isWritable: true  },
        { pubkey: rejectClaim,              isSigner: false, isWritable: true  },
      ],
      data: encodeInsurerDecideClaim(false, 42),
    });
    await sendIx(connection, [rejectIx], [insurer.entity], insurer.entity.publicKey, "insurer_decide_claim (rejeté, code 42)");
    claimInfo = await connection.getAccountInfo(rejectClaim);
    assert.strictEqual(claimInfo!.data.readUInt8(72), ClaimDecision.Rejected);
    assert.strictEqual((claimInfo!.data as Buffer).readUInt16LE(81), 42);
  });

  // ── 7. Identité, dossiers médicaux, audit accès ───────────────────────────

  it("7 – identité custodiale, ancrage dossier médical, log accès avec nonce", async () => {
    const hospital = await registerAndApproveEntity(connection, payer, configPda, Role.Hospital, "Hospital");
    const patient  = await createPatientProfile(connection, hospital);

    // Enregistrement identité utilisateur (admin)
    const appUserIdHash  = crypto.randomBytes(32);
    const patientWallet  = anchor.web3.Keypair.generate();
    await fundWithPayer(connection, payer, patientWallet.publicKey);

    const identityPda = getUserIdentityPda(appUserIdHash);
    logAccount("user_identity", identityPda);

    const registerIdentityIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey,                     isSigner: true,  isWritable: true  },
        { pubkey: configPda,                           isSigner: false, isWritable: false },
        { pubkey: identityPda,                         isSigner: false, isWritable: true  },
        { pubkey: anchor.web3.SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: encodeRegisterUserIdentity(appUserIdHash, patientWallet.publicKey, UserRoleClass.Patient),
    });
    await sendIx(connection, [registerIdentityIx], [payer], payer.publicKey, "register_user_identity");

    const identityInfo = await connection.getAccountInfo(identityPda);
    assert(identityInfo, "user identity not found");
    assert.strictEqual(identityInfo.data.length, USER_IDENTITY_SIZE);
    assert(readPubkey(identityInfo.data as Buffer, 40).equals(patientWallet.publicKey));
    assert.strictEqual(identityInfo.data.readUInt8(72), UserRoleClass.Patient);
    assert.strictEqual(identityInfo.data.readUInt8(73), IdentityStatus.Active);

    // Ancrage dossier médical (hospital paie le rent)
    const recordHash  = crypto.randomBytes(32);
    const pointerHash = crypto.randomBytes(32);
    const recordPda   = getMedicalRecordPda(patient.patientPda, recordHash);
    logAccount("medical_record", recordPda);

    const addRecordIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: hospital.entity.publicKey,           isSigner: true,  isWritable: true  },
        { pubkey: hospital.rolePda,                    isSigner: false, isWritable: false },
        { pubkey: patient.patientPda,                  isSigner: false, isWritable: false },
        { pubkey: recordPda,                           isSigner: false, isWritable: true  },
        { pubkey: anchor.web3.SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: encodeAddMedicalRecordAnchor(
        patient.patientIdHash, RecordType.Consultation, recordHash, pointerHash, 1
      ),
    });
    await sendIx(connection, [addRecordIx], [hospital.entity], hospital.entity.publicKey, "add_medical_record_anchor (Consultation v1)");

    let recordInfo = await connection.getAccountInfo(recordPda);
    assert(recordInfo, "medical record not found");
    assert.strictEqual(recordInfo.data.length, MEDICAL_RECORD_SIZE);
    assert.strictEqual(recordInfo.data.readUInt8(72), RecordType.Consultation);
    assert.strictEqual(recordInfo.data.readUInt32LE(137), 1);
    assert.strictEqual(recordInfo.data.readUInt8(141), RecordStatus.Active);

    // Supersession
    const replacement = anchor.web3.Keypair.generate().publicKey;
    const supersedeIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: hospital.entity.publicKey, isSigner: true,  isWritable: true  },
        { pubkey: hospital.rolePda,          isSigner: false, isWritable: false },
        { pubkey: recordPda,                 isSigner: false, isWritable: true  },
      ],
      data: encodeSupersedeMedicalRecord(replacement),
    });
    await sendIx(connection, [supersedeIx], [hospital.entity], hospital.entity.publicKey, "supersede_medical_record");
    recordInfo = await connection.getAccountInfo(recordPda);
    assert.strictEqual(recordInfo!.data.readUInt8(141), RecordStatus.Superseded);
    assert(readPubkey(recordInfo!.data as Buffer, 142).equals(replacement));

    // log_access_event – nonce 1
    const nonce1         = 1;
    const accessEventPda = getAccessEventPda(patient.patientPda, patientWallet.publicKey, recordHash, nonce1);
    logAccount("access_event/nonce1", accessEventPda);

    const logAccess1Ix = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: patientWallet.publicKey,             isSigner: true,  isWritable: true  },
        { pubkey: identityPda,                         isSigner: false, isWritable: false },
        { pubkey: patient.patientPda,                  isSigner: false, isWritable: false },
        { pubkey: recordPda,                           isSigner: false, isWritable: false },
        { pubkey: accessEventPda,                      isSigner: false, isWritable: true  },
        { pubkey: anchor.web3.SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: encodeLogAccessEvent(patient.patientIdHash, AccessKind.Read, recordHash, nonce1),
    });
    await sendIx(connection, [logAccess1Ix], [patientWallet], patientWallet.publicKey, "log_access_event (nonce=1)");

    let accessInfo = await connection.getAccountInfo(accessEventPda);
    assert(accessInfo, "access event not found");
    assert.strictEqual(accessInfo.data.length, ACCESS_EVENT_SIZE);
    assert.strictEqual(accessInfo.data.readUInt8(104), AccessKind.Read);
    assert.strictEqual((accessInfo.data as Buffer).readBigUInt64LE(145), BigInt(nonce1));

    // log_access_event – nonce 2 (pas de collision PDA)
    const nonce2          = 2;
    const accessEventPda2 = getAccessEventPda(patient.patientPda, patientWallet.publicKey, recordHash, nonce2);
    logAccount("access_event/nonce2", accessEventPda2);

    const logAccess2Ix = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: patientWallet.publicKey,             isSigner: true,  isWritable: true  },
        { pubkey: identityPda,                         isSigner: false, isWritable: false },
        { pubkey: patient.patientPda,                  isSigner: false, isWritable: false },
        { pubkey: recordPda,                           isSigner: false, isWritable: false },
        { pubkey: accessEventPda2,                     isSigner: false, isWritable: true  },
        { pubkey: anchor.web3.SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: encodeLogAccessEvent(patient.patientIdHash, AccessKind.Read, recordHash, nonce2),
    });
    await sendIx(connection, [logAccess2Ix], [patientWallet], patientWallet.publicKey, "log_access_event (nonce=2)");

    accessInfo = await connection.getAccountInfo(accessEventPda2);
    assert(accessInfo, "second access event not found");
    assert.strictEqual((accessInfo.data as Buffer).readBigUInt64LE(145), BigInt(nonce2));
  });
});
