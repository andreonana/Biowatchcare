const assert = require("assert");
const anchor = require("@coral-xyz/anchor");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PROGRAM_ID = new anchor.web3.PublicKey(
  "24paEKyzz4aoBDmpdGVyC4Larnp7Bwka95TkgLHoLTiC"
);

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

// Updated sizes after the security refactor:
//   GlobalConfig  : +pending_admin(32) +payment_mint(32)  → 57 + 64 = 121
//   Invoice       : +hospital(32)                          → 92 + 32 = 124
//   ClaimStatus   : +settled(1)                            → 84 +  1 = 85
//   AccessEvent   : +nonce(8)                              → 146 + 8 = 154
const CONFIG_SIZE        = 121;
const ENTITY_ROLE_SIZE   = 115;
const PATIENT_SIZE       = 82;
const USER_IDENTITY_SIZE = 91;
const CONSENT_SIZE       = 94;
const MEDICAL_RECORD_SIZE = 191;
const PRESCRIPTION_SIZE  = 146;
const QR_TOKEN_SIZE      = 122;
const DISPENSE_SIZE      = 113;
const INVOICE_SIZE       = 124;
const CLAIM_SIZE         = 85;
const ACCESS_EVENT_SIZE  = 154;

const DEFAULT_THRESHOLD    = 75000n;
const VIEW_RECORDS         = 1 << 0;
const VIEW_PRESCRIPTIONS   = 1 << 1;
const VIEW_INVOICES        = 1 << 2;
const VIEW_ALL             = VIEW_RECORDS | VIEW_PRESCRIPTIONS | VIEW_INVOICES;
const QR_TOKEN_LIFETIME_SECS = 48 * 60 * 60;
const RPC_URL = process.env.ANCHOR_PROVIDER_URL || "http://127.0.0.1:8899";
const ZERO_PUBKEY = new anchor.web3.PublicKey("11111111111111111111111111111111");

const Role = { Hospital: 0, Insurer: 1, Doctor: 2, Pharmacist: 3 };
const EntityStatus = { Pending: 0, Approved: 1, Revoked: 2 };
const PatientStatus = { Active: 0 };
const RxStatus = { Active: 0, Cancelled: 1 };
const ClaimDecision = { AutoApproved: 0, Pending: 1, Approved: 2, Rejected: 3 };
const UserRoleClass = { Patient: 0, Practitioner: 1, Operator: 2 };
const IdentityStatus = { Active: 0, Suspended: 1 };
const RecordType = { Consultation: 0, LabResult: 1, Imaging: 2, Vaccination: 3, ClinicalNote: 4, ExternalDocument: 5 };
const RecordStatus = { Active: 0, Archived: 1, Superseded: 2 };
const AccessKind = { Read: 0, Write: 1, Share: 2, Export: 3 };

// ── Keypair helpers ──────────────────────────────────────────────────────────

function expandHome(p) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

function loadKeypairIfExists(keypairPath) {
  if (!keypairPath) return null;
  const full = expandHome(keypairPath);
  if (!fs.existsSync(full)) return null;
  return anchor.web3.Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(full, "utf8")))
  );
}

async function getPayer(connection, allowAirdrop = true) {
  const localFallback = path.join(process.cwd(), ".anchor", "localnet-admin.json");
  for (const candidate of [
    process.env.ANCHOR_WALLET,
    path.join(os.homedir(), ".config", "solana", "id.json"),
    localFallback,
  ]) {
    const kp = loadKeypairIfExists(candidate);
    if (kp) return kp;
  }
  if (!allowAirdrop) return null;
  const kp = anchor.web3.Keypair.generate();
  fs.mkdirSync(path.dirname(localFallback), { recursive: true });
  fs.writeFileSync(localFallback, JSON.stringify(Array.from(kp.secretKey)), "utf8");
  const sig = await connection.requestAirdrop(kp.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig, "confirmed");
  return kp;
}

async function airdrop(connection, pubkey, lamports = anchor.web3.LAMPORTS_PER_SOL) {
  const sig = await connection.requestAirdrop(pubkey, lamports);
  await connection.confirmTransaction(sig, "confirmed");
}

// ── Instruction encoding ────────────────────────────────────────────────────

function discriminator(name) {
  return crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function encodeInitializeConfig(threshold) {
  const disc = discriminator("initialize_config");
  const data = Buffer.alloc(1 + 8);
  data.writeUInt8(1, 0);
  data.writeBigUInt64LE(BigInt(threshold), 1);
  return Buffer.concat([disc, data]);
}

function encodeSetThreshold(threshold) {
  const disc = discriminator("set_threshold");
  const data = Buffer.alloc(8);
  data.writeBigUInt64LE(BigInt(threshold), 0);
  return Buffer.concat([disc, data]);
}

function encodeProposeAdminTransfer(newAdminPubkey) {
  const disc = discriminator("propose_admin_transfer");
  return Buffer.concat([disc, newAdminPubkey.toBuffer()]);
}

function encodeRegisterEntity(role, entityPubkey, metadataHash) {
  const disc = discriminator("register_entity");
  const data = Buffer.alloc(1 + 32 + 32);
  data.writeUInt8(role, 0);
  entityPubkey.toBuffer().copy(data, 1);
  metadataHash.copy(data, 33);
  return Buffer.concat([disc, data]);
}

function encodeCreatePatientProfile(patientIdHash) {
  return Buffer.concat([discriminator("create_patient_profile"), patientIdHash]);
}

function encodeRegisterUserIdentity(appUserIdHash, walletPubkey, roleClass) {
  const disc = discriminator("register_user_identity");
  const data = Buffer.alloc(32 + 32 + 1);
  appUserIdHash.copy(data, 0);
  walletPubkey.toBuffer().copy(data, 32);
  data.writeUInt8(roleClass, 64);
  return Buffer.concat([disc, data]);
}

function encodeGrantConsent(patientIdHash, granteePubkey, scopes, expiresAt) {
  const disc = discriminator("grant_consent");
  const data = Buffer.alloc(32 + 32 + 4 + 8);
  patientIdHash.copy(data, 0);
  granteePubkey.toBuffer().copy(data, 32);
  data.writeUInt32LE(scopes, 64);
  data.writeBigInt64LE(BigInt(expiresAt), 68);
  return Buffer.concat([disc, data]);
}

function encodeUpdateConsent(patientIdHash, granteePubkey, scopes, expiresAt) {
  const disc = discriminator("update_consent");
  const data = Buffer.alloc(32 + 32 + 4 + 8);
  patientIdHash.copy(data, 0);
  granteePubkey.toBuffer().copy(data, 32);
  data.writeUInt32LE(scopes, 64);
  data.writeBigInt64LE(BigInt(expiresAt), 68);
  return Buffer.concat([disc, data]);
}

function encodeRevokeConsent(patientIdHash, granteePubkey) {
  const disc = discriminator("revoke_consent");
  const data = Buffer.alloc(32 + 32);
  patientIdHash.copy(data, 0);
  granteePubkey.toBuffer().copy(data, 32);
  return Buffer.concat([disc, data]);
}

function encodeAddPrescription(patientIdHash, rxHash, pointerHash) {
  return Buffer.concat([discriminator("add_prescription"), patientIdHash, rxHash, pointerHash]);
}

function encodeAddMedicalRecordAnchor(patientIdHash, recordType, recordHash, pointerHash, version) {
  const disc = discriminator("add_medical_record_anchor");
  const data = Buffer.alloc(32 + 1 + 32 + 32 + 4);
  patientIdHash.copy(data, 0);
  data.writeUInt8(recordType, 32);
  recordHash.copy(data, 33);
  pointerHash.copy(data, 65);
  data.writeUInt32LE(version, 97);
  return Buffer.concat([disc, data]);
}

function encodeSupersedeMedicalRecord(supersededBy) {
  return Buffer.concat([discriminator("supersede_medical_record"), supersededBy.toBuffer()]);
}

// nonce is u64 little-endian
function encodeLogAccessEvent(patientIdHash, accessKind, resourceHash, nonce) {
  const disc = discriminator("log_access_event");
  const data = Buffer.alloc(32 + 1 + 32 + 8);
  patientIdHash.copy(data, 0);
  data.writeUInt8(accessKind, 32);
  resourceHash.copy(data, 33);
  data.writeBigUInt64LE(BigInt(nonce), 65);
  return Buffer.concat([disc, data]);
}

function encodeIssueQrToken(tokenHash) {
  return Buffer.concat([discriminator("issue_qr_token"), tokenHash]);
}

function encodeDispenseWithQr(dispenseHash) {
  return Buffer.concat([discriminator("dispense_with_qr"), dispenseHash]);
}

function encodeCreateInvoice(patientIdHash, invoiceHash, amount, currencyCode) {
  const disc = discriminator("create_invoice");
  const data = Buffer.alloc(32 + 32 + 8 + 3);
  patientIdHash.copy(data, 0);
  invoiceHash.copy(data, 32);
  data.writeBigUInt64LE(BigInt(amount), 64);
  Buffer.from(currencyCode, "ascii").copy(data, 72);
  return Buffer.concat([disc, data]);
}

function encodeAutoOrPendingClaim(insurerPubkey) {
  return Buffer.concat([discriminator("auto_or_pending_claim"), insurerPubkey.toBuffer()]);
}

function encodeInsurerDecideClaim(approve, reasonCode) {
  const disc = discriminator("insurer_decide_claim");
  const data = Buffer.alloc(1 + 2);
  data.writeUInt8(approve ? 1 : 0, 0);
  data.writeUInt16LE(reasonCode, 1);
  return Buffer.concat([disc, data]);
}

function encodeNoArgs(name) {
  return discriminator(name);
}

// ── PDA helpers ──────────────────────────────────────────────────────────────

function readPubkey(data, offset) {
  return new anchor.web3.PublicKey(data.slice(offset, offset + 32));
}

function readI64(data, offset) {
  return Number(data.readBigInt64LE(offset));
}

function getConfigPda() {
  return anchor.web3.PublicKey.findProgramAddressSync([CONFIG_SEED], PROGRAM_ID)[0];
}

function getRolePda(entityPubkey) {
  return anchor.web3.PublicKey.findProgramAddressSync(
    [ROLE_SEED, entityPubkey.toBuffer()], PROGRAM_ID
  )[0];
}

function getUserIdentityPda(appUserIdHash) {
  return anchor.web3.PublicKey.findProgramAddressSync(
    [USER_IDENTITY_SEED, appUserIdHash], PROGRAM_ID
  )[0];
}

function getPatientPda(patientIdHash) {
  return anchor.web3.PublicKey.findProgramAddressSync(
    [PATIENT_SEED, patientIdHash], PROGRAM_ID
  )[0];
}

function getConsentPda(patientPda, granteePubkey) {
  return anchor.web3.PublicKey.findProgramAddressSync(
    [CONSENT_SEED, patientPda.toBuffer(), granteePubkey.toBuffer()], PROGRAM_ID
  )[0];
}

function getMedicalRecordPda(patientPda, recordHash) {
  return anchor.web3.PublicKey.findProgramAddressSync(
    [RECORD_SEED, patientPda.toBuffer(), recordHash], PROGRAM_ID
  )[0];
}

// nonce (number) is included in the seed — prevents PDA collision.
function getAccessEventPda(patientPda, accessorPubkey, resourceHash, nonce) {
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(BigInt(nonce));
  return anchor.web3.PublicKey.findProgramAddressSync(
    [ACCESS_EVENT_SEED, patientPda.toBuffer(), accessorPubkey.toBuffer(), resourceHash, nonceBuf],
    PROGRAM_ID
  )[0];
}

function getPrescriptionPda(patientPda, rxHash) {
  return anchor.web3.PublicKey.findProgramAddressSync(
    [RX_SEED, patientPda.toBuffer(), rxHash], PROGRAM_ID
  )[0];
}

function getQrPda(prescriptionPda, tokenHash) {
  return anchor.web3.PublicKey.findProgramAddressSync(
    [QR_SEED, prescriptionPda.toBuffer(), tokenHash], PROGRAM_ID
  )[0];
}

function getDispensePda(prescriptionPda, pharmacistPubkey) {
  return anchor.web3.PublicKey.findProgramAddressSync(
    [DISPENSE_SEED, prescriptionPda.toBuffer(), pharmacistPubkey.toBuffer()], PROGRAM_ID
  )[0];
}

function getInvoicePda(patientPda, invoiceHash) {
  return anchor.web3.PublicKey.findProgramAddressSync(
    [INVOICE_SEED, patientPda.toBuffer(), invoiceHash], PROGRAM_ID
  )[0];
}

function getClaimPda(invoicePda, insurerPubkey) {
  return anchor.web3.PublicKey.findProgramAddressSync(
    [CLAIM_SEED, invoicePda.toBuffer(), insurerPubkey.toBuffer()], PROGRAM_ID
  )[0];
}

// ── Transaction helpers ──────────────────────────────────────────────────────

async function sendInstruction(connection, instructions, signers, feePayer) {
  const tx = new anchor.web3.Transaction();
  for (const ix of instructions) tx.add(ix);
  tx.feePayer = feePayer;
  return anchor.web3.sendAndConfirmTransaction(connection, tx, signers, {
    commitment: "confirmed",
  });
}

async function getConfigInfo(connection) {
  const configPda = getConfigPda();
  const info = await connection.getAccountInfo(configPda);
  const admin = info ? readPubkey(info.data, 8) : null;
  return { configPda, info, admin };
}

async function createConfig(connection, payer) {
  const configPda = getConfigPda();
  const ix = new anchor.web3.TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: anchor.web3.SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: encodeInitializeConfig(DEFAULT_THRESHOLD),
  });
  await sendInstruction(connection, [ix], [payer], payer.publicKey);
}

async function ensureConfig(connection) {
  const payer = await getPayer(connection, true);
  let { configPda, info, admin } = await getConfigInfo(connection);
  if (!info) {
    await createConfig(connection, payer);
    ({ configPda, info, admin } = await getConfigInfo(connection));
  }
  assert(info, "config account not found");
  assert(admin.equals(payer.publicKey), "admin wallet does not match config admin");
  return { payer, configPda, info };
}

async function setThreshold(connection, payer, configPda, value) {
  const ix = new anchor.web3.TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
    ],
    data: encodeSetThreshold(value),
  });
  await sendInstruction(connection, [ix], [payer], payer.publicKey);
}

// ── Shared test helpers ──────────────────────────────────────────────────────

async function registerAndApproveEntity(connection, payer, configPda, role) {
  const entity = anchor.web3.Keypair.generate();
  // Fund entity so it can pay rent for its own operational accounts.
  await airdrop(connection, entity.publicKey);

  const rolePda = getRolePda(entity.publicKey);
  const metadataHash = crypto.randomBytes(32);

  const registerIx = new anchor.web3.TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: false },
      { pubkey: rolePda, isSigner: false, isWritable: true },
      { pubkey: anchor.web3.SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: encodeRegisterEntity(role, entity.publicKey, metadataHash),
  });

  const approveIx = new anchor.web3.TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: false },
      { pubkey: rolePda, isSigner: false, isWritable: true },
    ],
    data: encodeNoArgs("approve_entity"),
  });

  await sendInstruction(connection, [registerIx, approveIx], [payer], payer.publicKey);

  const roleInfo = await connection.getAccountInfo(rolePda);
  assert(roleInfo, "role account not found");
  assert.strictEqual(roleInfo.data.length, ENTITY_ROLE_SIZE);
  assert(readPubkey(roleInfo.data, 8).equals(entity.publicKey));
  assert.strictEqual(roleInfo.data.readUInt8(40), role);
  assert.strictEqual(roleInfo.data.readUInt8(41), EntityStatus.Approved);

  return { entity, rolePda };
}

// Staff pays its own rent for the patient profile (no admin co-sign).
async function createPatientProfile(connection, staff) {
  const patientIdHash = crypto.randomBytes(32);
  const patientPda = getPatientPda(patientIdHash);

  const ix = new anchor.web3.TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: staff.entity.publicKey, isSigner: true, isWritable: true },
      { pubkey: getConfigPda(), isSigner: false, isWritable: false },
      { pubkey: staff.rolePda, isSigner: false, isWritable: false },
      { pubkey: patientPda, isSigner: false, isWritable: true },
      { pubkey: anchor.web3.SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: encodeCreatePatientProfile(patientIdHash),
  });

  await sendInstruction(connection, [ix], [staff.entity], staff.entity.publicKey);

  const patientInfo = await connection.getAccountInfo(patientPda);
  assert(patientInfo, "patient account not found");
  assert.strictEqual(patientInfo.data.length, PATIENT_SIZE);
  assert.deepStrictEqual(patientInfo.data.slice(8, 40), patientIdHash);
  assert.strictEqual(patientInfo.data.readUInt8(40), PatientStatus.Active);
  assert(readPubkey(patientInfo.data, 41).equals(staff.entity.publicKey));

  return { patientIdHash, patientPda, patientInfo };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("biowatchcare", () => {
  let connection;
  let payer;
  let configPda;

  before(async () => {
    connection = new anchor.web3.Connection(RPC_URL, "confirmed");
    ({ payer, configPda } = await ensureConfig(connection));
    await setThreshold(connection, payer, configPda, DEFAULT_THRESHOLD);
  });

  // ── 1. Config & threshold ────────────────────────────────────────────────

  it("initializes the config PDA and updates the threshold", async () => {
    const configInfo = await connection.getAccountInfo(configPda);
    assert(configInfo, "config account not found");
    assert.strictEqual(configInfo.data.length, CONFIG_SIZE);
    // offset 8 = admin
    assert(readPubkey(configInfo.data, 8).equals(payer.publicKey));
    // offset 40 = auto_reimb_threshold
    assert.strictEqual(configInfo.data.readBigUInt64LE(40), DEFAULT_THRESHOLD);
    // offset 57 = pending_admin (should be zero at init)
    assert.deepStrictEqual(configInfo.data.slice(57, 89), Buffer.alloc(32));

    const newThreshold = DEFAULT_THRESHOLD + 123n;
    await setThreshold(connection, payer, configPda, newThreshold);
    const updated = await connection.getAccountInfo(configPda);
    assert.strictEqual(updated.data.readBigUInt64LE(40), newThreshold);

    await setThreshold(connection, payer, configPda, DEFAULT_THRESHOLD);
    console.log("Configuration et seuil testes avec succes");
  });

  // ── 2. Admin transfer (2-step) ────────────────────────────────────────────

  it("2-step admin transfer: propose then accept, then restore", async () => {
    const newAdmin = anchor.web3.Keypair.generate();
    await airdrop(connection, newAdmin.publicKey);

    // Step 1: propose
    const proposeIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: configPda, isSigner: false, isWritable: true },
      ],
      data: encodeProposeAdminTransfer(newAdmin.publicKey),
    });
    await sendInstruction(connection, [proposeIx], [payer], payer.publicKey);

    let info = await connection.getAccountInfo(configPda);
    // offset 57 = pending_admin
    assert(readPubkey(info.data, 57).equals(newAdmin.publicKey), "pending_admin mismatch");

    // Step 2: accept
    const acceptIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: newAdmin.publicKey, isSigner: true, isWritable: true },
        { pubkey: configPda, isSigner: false, isWritable: true },
      ],
      data: encodeNoArgs("accept_admin_transfer"),
    });
    await sendInstruction(connection, [acceptIx], [newAdmin], newAdmin.publicKey);

    info = await connection.getAccountInfo(configPda);
    assert(readPubkey(info.data, 8).equals(newAdmin.publicKey), "admin not updated");
    assert.deepStrictEqual(info.data.slice(57, 89), Buffer.alloc(32), "pending_admin not cleared");

    // Restore: newAdmin proposes back to payer
    const restoreIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: newAdmin.publicKey, isSigner: true, isWritable: true },
        { pubkey: configPda, isSigner: false, isWritable: true },
      ],
      data: encodeProposeAdminTransfer(payer.publicKey),
    });
    await sendInstruction(connection, [restoreIx], [newAdmin], newAdmin.publicKey);

    const acceptBackIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: configPda, isSigner: false, isWritable: true },
      ],
      data: encodeNoArgs("accept_admin_transfer"),
    });
    await sendInstruction(connection, [acceptBackIx], [payer], payer.publicKey);

    info = await connection.getAccountInfo(configPda);
    assert(readPubkey(info.data, 8).equals(payer.publicKey), "admin not restored");
    console.log("Transfert admin 2-etapes teste avec succes");
  });

  // ── 3. Entity role lifecycle ──────────────────────────────────────────────

  it("registers, approves, and revokes an entity role", async () => {
    const entity = anchor.web3.Keypair.generate();
    const rolePda = getRolePda(entity.publicKey);

    const registerIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: configPda, isSigner: false, isWritable: false },
        { pubkey: rolePda, isSigner: false, isWritable: true },
        { pubkey: anchor.web3.SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: encodeRegisterEntity(Role.Doctor, entity.publicKey, crypto.randomBytes(32)),
    });
    await sendInstruction(connection, [registerIx], [payer], payer.publicKey);

    let roleInfo = await connection.getAccountInfo(rolePda);
    assert(roleInfo, "role account not found");
    assert.strictEqual(roleInfo.data.length, ENTITY_ROLE_SIZE);
    assert.strictEqual(roleInfo.data.readUInt8(40), Role.Doctor);
    assert.strictEqual(roleInfo.data.readUInt8(41), EntityStatus.Pending);

    const approveIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: configPda, isSigner: false, isWritable: false },
        { pubkey: rolePda, isSigner: false, isWritable: true },
      ],
      data: encodeNoArgs("approve_entity"),
    });
    await sendInstruction(connection, [approveIx], [payer], payer.publicKey);

    roleInfo = await connection.getAccountInfo(rolePda);
    assert.strictEqual(roleInfo.data.readUInt8(41), EntityStatus.Approved);
    assert(readPubkey(roleInfo.data, 74).equals(payer.publicKey));

    const revokeIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: configPda, isSigner: false, isWritable: false },
        { pubkey: rolePda, isSigner: false, isWritable: true },
      ],
      data: encodeNoArgs("revoke_entity"),
    });
    await sendInstruction(connection, [revokeIx], [payer], payer.publicKey);

    roleInfo = await connection.getAccountInfo(rolePda);
    assert.strictEqual(roleInfo.data.readUInt8(41), EntityStatus.Revoked);
    console.log("Cycle de vie role admin teste avec succes");
  });

  // ── 4. Patient profile & consent lifecycle ─────────────────────────────────

  it("creates a patient profile and manages consent lifecycle", async () => {
    const hospital = await registerAndApproveEntity(connection, payer, configPda, Role.Hospital);
    const patient  = await createPatientProfile(connection, hospital);

    // Patient wallet — needs SOL to pay for the Consent PDA
    const patientSigner = anchor.web3.Keypair.generate();
    await airdrop(connection, patientSigner.publicKey);

    const consentPda = getConsentPda(patient.patientPda, hospital.entity.publicKey);
    const expiresAt  = Math.floor(Date.now() / 1000) + 3600;

    // grant_consent: patient pays, no admin
    const grantIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: patientSigner.publicKey, isSigner: true, isWritable: true },
        { pubkey: patient.patientPda, isSigner: false, isWritable: false },
        { pubkey: consentPda, isSigner: false, isWritable: true },
        { pubkey: anchor.web3.SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: encodeGrantConsent(patient.patientIdHash, hospital.entity.publicKey, VIEW_ALL, expiresAt),
    });
    await sendInstruction(connection, [grantIx], [patientSigner], patientSigner.publicKey);

    let consentInfo = await connection.getAccountInfo(consentPda);
    assert(consentInfo, "consent account not found");
    assert.strictEqual(consentInfo.data.length, CONSENT_SIZE);
    assert(readPubkey(consentInfo.data, 8).equals(patient.patientPda));
    assert(readPubkey(consentInfo.data, 40).equals(hospital.entity.publicKey));
    assert.strictEqual(consentInfo.data.readUInt32LE(72), VIEW_ALL);
    assert.strictEqual(readI64(consentInfo.data, 76), expiresAt);
    assert.strictEqual(consentInfo.data.readUInt8(84), 0); // revoked = false

    // update_consent: change scopes, no admin
    const newScopes    = VIEW_RECORDS;
    const newExpiresAt = expiresAt + 7200;
    const updateIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: patientSigner.publicKey, isSigner: true, isWritable: true },
        { pubkey: patient.patientPda, isSigner: false, isWritable: false },
        { pubkey: consentPda, isSigner: false, isWritable: true },
      ],
      data: encodeUpdateConsent(patient.patientIdHash, hospital.entity.publicKey, newScopes, newExpiresAt),
    });
    await sendInstruction(connection, [updateIx], [patientSigner], patientSigner.publicKey);

    consentInfo = await connection.getAccountInfo(consentPda);
    assert.strictEqual(consentInfo.data.readUInt32LE(72), newScopes);
    assert.strictEqual(readI64(consentInfo.data, 76), newExpiresAt);

    // revoke_consent: patient signs alone, no admin
    const revokeIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: patientSigner.publicKey, isSigner: true, isWritable: true },
        { pubkey: patient.patientPda, isSigner: false, isWritable: false },
        { pubkey: consentPda, isSigner: false, isWritable: true },
      ],
      data: encodeRevokeConsent(patient.patientIdHash, hospital.entity.publicKey),
    });
    await sendInstruction(connection, [revokeIx], [patientSigner], patientSigner.publicKey);

    consentInfo = await connection.getAccountInfo(consentPda);
    assert.strictEqual(consentInfo.data.readUInt8(84), 1); // revoked = true

    // update_consent after revoke resets revoked flag
    const reactivateIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: patientSigner.publicKey, isSigner: true, isWritable: true },
        { pubkey: patient.patientPda, isSigner: false, isWritable: false },
        { pubkey: consentPda, isSigner: false, isWritable: true },
      ],
      data: encodeUpdateConsent(patient.patientIdHash, hospital.entity.publicKey, VIEW_ALL, expiresAt),
    });
    await sendInstruction(connection, [reactivateIx], [patientSigner], patientSigner.publicKey);

    consentInfo = await connection.getAccountInfo(consentPda);
    assert.strictEqual(consentInfo.data.readUInt8(84), 0); // revoked = false again
    console.log("Profil patient et consentement testes avec succes");
  });

  // ── 5. Prescription, QR, dispense, cancellation ───────────────────────────

  it("handles prescription, qr verification, dispense, and cancellation", async () => {
    const hospital   = await registerAndApproveEntity(connection, payer, configPda, Role.Hospital);
    const doctor     = await registerAndApproveEntity(connection, payer, configPda, Role.Doctor);
    const pharmacist = await registerAndApproveEntity(connection, payer, configPda, Role.Pharmacist);
    const patient    = await createPatientProfile(connection, hospital);

    const rxHash      = crypto.randomBytes(32);
    const pointerHash = crypto.randomBytes(32);
    const prescriptionPda = getPrescriptionPda(patient.patientPda, rxHash);

    // Doctor pays rent — no admin
    const addRxIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: doctor.entity.publicKey, isSigner: true, isWritable: true },
        { pubkey: doctor.rolePda, isSigner: false, isWritable: false },
        { pubkey: patient.patientPda, isSigner: false, isWritable: false },
        { pubkey: prescriptionPda, isSigner: false, isWritable: true },
        { pubkey: anchor.web3.SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: encodeAddPrescription(patient.patientIdHash, rxHash, pointerHash),
    });
    await sendInstruction(connection, [addRxIx], [doctor.entity], doctor.entity.publicKey);

    let prescriptionInfo = await connection.getAccountInfo(prescriptionPda);
    assert(prescriptionInfo, "prescription account not found");
    assert.strictEqual(prescriptionInfo.data.length, PRESCRIPTION_SIZE);
    assert(readPubkey(prescriptionInfo.data, 8).equals(patient.patientPda));
    assert.deepStrictEqual(prescriptionInfo.data.slice(40, 72), rxHash);
    assert(readPubkey(prescriptionInfo.data, 72).equals(doctor.entity.publicKey));
    assert.deepStrictEqual(prescriptionInfo.data.slice(104, 136), pointerHash);
    assert.strictEqual(prescriptionInfo.data.readUInt8(144), RxStatus.Active);

    // Doctor pays rent for QR token
    const tokenHash = crypto.randomBytes(32);
    const qrPda     = getQrPda(prescriptionPda, tokenHash);
    const issueQrIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: doctor.entity.publicKey, isSigner: true, isWritable: true },
        { pubkey: doctor.rolePda, isSigner: false, isWritable: false },
        { pubkey: prescriptionPda, isSigner: false, isWritable: true },
        { pubkey: qrPda, isSigner: false, isWritable: true },
        { pubkey: anchor.web3.SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: encodeIssueQrToken(tokenHash),
    });
    await sendInstruction(connection, [issueQrIx], [doctor.entity], doctor.entity.publicKey);

    let qrInfo = await connection.getAccountInfo(qrPda);
    assert(qrInfo, "qr token account not found");
    assert.strictEqual(qrInfo.data.length, QR_TOKEN_SIZE);
    assert(readPubkey(qrInfo.data, 8).equals(prescriptionPda));
    assert.deepStrictEqual(qrInfo.data.slice(40, 72), tokenHash);
    const expiresAt = readI64(qrInfo.data, 72);
    const now = Math.floor(Date.now() / 1000);
    assert(expiresAt > now);
    assert(expiresAt <= now + QR_TOKEN_LIFETIME_SECS + 30);
    assert.strictEqual(qrInfo.data.readUInt8(80), 0); // used = false

    // Pharmacist verifies — no new account
    const verifyQrIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: pharmacist.entity.publicKey, isSigner: true, isWritable: true },
        { pubkey: pharmacist.rolePda, isSigner: false, isWritable: false },
        { pubkey: qrPda, isSigner: false, isWritable: false },
      ],
      data: encodeNoArgs("verify_qr_token"),
    });
    await sendInstruction(connection, [verifyQrIx], [pharmacist.entity], pharmacist.entity.publicKey);

    // Pharmacist pays rent for Dispense record
    const dispenseHash  = crypto.randomBytes(32);
    const dispensePda   = getDispensePda(prescriptionPda, pharmacist.entity.publicKey);
    const dispenseIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: pharmacist.entity.publicKey, isSigner: true, isWritable: true },
        { pubkey: pharmacist.rolePda, isSigner: false, isWritable: false },
        { pubkey: qrPda, isSigner: false, isWritable: true },
        { pubkey: dispensePda, isSigner: false, isWritable: true },
        { pubkey: anchor.web3.SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: encodeDispenseWithQr(dispenseHash),
    });
    await sendInstruction(connection, [dispenseIx], [pharmacist.entity], pharmacist.entity.publicKey);

    qrInfo = await connection.getAccountInfo(qrPda);
    assert.strictEqual(qrInfo.data.readUInt8(80), 1); // used = true
    assert(readPubkey(qrInfo.data, 89).equals(pharmacist.entity.publicKey));

    const dispenseInfo = await connection.getAccountInfo(dispensePda);
    assert(dispenseInfo, "dispense account not found");
    assert.strictEqual(dispenseInfo.data.length, DISPENSE_SIZE);
    assert(readPubkey(dispenseInfo.data, 8).equals(prescriptionPda));
    assert(readPubkey(dispenseInfo.data, 40).equals(pharmacist.entity.publicKey));
    assert.deepStrictEqual(dispenseInfo.data.slice(72, 104), dispenseHash);

    // Verify QR again must fail — already used
    await assert.rejects(
      sendInstruction(connection, [verifyQrIx], [pharmacist.entity], pharmacist.entity.publicKey),
      /QrAlreadyUsed|custom program error|SendTransactionError/
    );

    // Prescription cancellation
    const cancelledRxHash      = crypto.randomBytes(32);
    const cancelledPointerHash = crypto.randomBytes(32);
    const cancelledPda = getPrescriptionPda(patient.patientPda, cancelledRxHash);

    const addCancelledRxIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: doctor.entity.publicKey, isSigner: true, isWritable: true },
        { pubkey: doctor.rolePda, isSigner: false, isWritable: false },
        { pubkey: patient.patientPda, isSigner: false, isWritable: false },
        { pubkey: cancelledPda, isSigner: false, isWritable: true },
        { pubkey: anchor.web3.SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: encodeAddPrescription(patient.patientIdHash, cancelledRxHash, cancelledPointerHash),
    });

    const cancelRxIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: doctor.entity.publicKey, isSigner: true, isWritable: true },
        { pubkey: doctor.rolePda, isSigner: false, isWritable: false },
        { pubkey: cancelledPda, isSigner: false, isWritable: true },
      ],
      data: encodeNoArgs("cancel_prescription"),
    });
    await sendInstruction(
      connection, [addCancelledRxIx, cancelRxIx], [doctor.entity], doctor.entity.publicKey
    );

    prescriptionInfo = await connection.getAccountInfo(cancelledPda);
    assert.strictEqual(prescriptionInfo.data.readUInt8(144), RxStatus.Cancelled);
    console.log("Prescription, QR et dispensation testes avec succes");
  });

  // ── 6. Invoices & claims ──────────────────────────────────────────────────

  it("creates invoices and handles auto, approved, and rejected claims", async () => {
    await setThreshold(connection, payer, configPda, DEFAULT_THRESHOLD);

    const hospital = await registerAndApproveEntity(connection, payer, configPda, Role.Hospital);
    const insurer  = await registerAndApproveEntity(connection, payer, configPda, Role.Insurer);
    const patient  = await createPatientProfile(connection, hospital);

    // Helper: hospital creates invoice (hospital pays rent, no admin)
    async function mkInvoice(invoiceHash, amount, currency) {
      const invoicePda = getInvoicePda(patient.patientPda, invoiceHash);
      const ix = new anchor.web3.TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: hospital.entity.publicKey, isSigner: true, isWritable: true },
          { pubkey: hospital.rolePda, isSigner: false, isWritable: false },
          { pubkey: patient.patientPda, isSigner: false, isWritable: false },
          { pubkey: invoicePda, isSigner: false, isWritable: true },
          { pubkey: anchor.web3.SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: encodeCreateInvoice(patient.patientIdHash, invoiceHash, amount, currency),
      });
      await sendInstruction(connection, [ix], [hospital.entity], hospital.entity.publicKey);
      return invoicePda;
    }

    // Helper: hospital submits claim (hospital pays rent, no admin)
    async function mkClaim(invoicePda, claimPda) {
      const ix = new anchor.web3.TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: hospital.entity.publicKey, isSigner: true, isWritable: true },
          { pubkey: hospital.rolePda, isSigner: false, isWritable: false },
          { pubkey: configPda, isSigner: false, isWritable: false },
          { pubkey: invoicePda, isSigner: false, isWritable: true },
          { pubkey: claimPda, isSigner: false, isWritable: true },
          { pubkey: insurer.entity.publicKey, isSigner: false, isWritable: false },
          { pubkey: anchor.web3.SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: encodeAutoOrPendingClaim(insurer.entity.publicKey),
      });
      await sendInstruction(connection, [ix], [hospital.entity], hospital.entity.publicKey);
    }

    // — Auto-approved claim (amount <= threshold) —
    const autoHash    = crypto.randomBytes(32);
    const autoAmount  = DEFAULT_THRESHOLD - 1n;
    const autoInvoice = await mkInvoice(autoHash, autoAmount, "XAF");
    const autoClaim   = getClaimPda(autoInvoice, insurer.entity.publicKey);
    await mkClaim(autoInvoice, autoClaim);

    let invoiceInfo = await connection.getAccountInfo(autoInvoice);
    assert(invoiceInfo, "invoice account not found");
    assert.strictEqual(invoiceInfo.data.length, INVOICE_SIZE);
    assert(readPubkey(invoiceInfo.data, 8).equals(patient.patientPda));
    assert.deepStrictEqual(invoiceInfo.data.slice(40, 72), autoHash);
    assert.strictEqual(invoiceInfo.data.readBigUInt64LE(72), autoAmount);
    assert.strictEqual(invoiceInfo.data.slice(80, 83).toString("ascii"), "XAF");
    // offset 91 = hospital pubkey (new field)
    assert(readPubkey(invoiceInfo.data, 91).equals(hospital.entity.publicKey));

    let claimInfo = await connection.getAccountInfo(autoClaim);
    assert(claimInfo, "auto claim account not found");
    assert.strictEqual(claimInfo.data.length, CLAIM_SIZE);
    assert.strictEqual(claimInfo.data.readUInt8(72), ClaimDecision.AutoApproved);
    assert.strictEqual(claimInfo.data.readUInt16LE(81), 0);
    assert.strictEqual(claimInfo.data.readUInt8(84), 0); // settled = false

    // — Pending then approved claim —
    const pendingHash    = crypto.randomBytes(32);
    const pendingAmount  = DEFAULT_THRESHOLD + 1000n;
    const pendingInvoice = await mkInvoice(pendingHash, pendingAmount, "EUR");
    const pendingClaim   = getClaimPda(pendingInvoice, insurer.entity.publicKey);
    await mkClaim(pendingInvoice, pendingClaim);

    claimInfo = await connection.getAccountInfo(pendingClaim);
    assert.strictEqual(claimInfo.data.readUInt8(72), ClaimDecision.Pending);

    // Insurer decides — no admin co-sign
    const approveIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: insurer.entity.publicKey, isSigner: true, isWritable: true },
        { pubkey: insurer.rolePda, isSigner: false, isWritable: false },
        { pubkey: pendingInvoice, isSigner: false, isWritable: true },
        { pubkey: pendingClaim, isSigner: false, isWritable: true },
      ],
      data: encodeInsurerDecideClaim(true, 0),
    });
    await sendInstruction(connection, [approveIx], [insurer.entity], insurer.entity.publicKey);

    claimInfo = await connection.getAccountInfo(pendingClaim);
    assert.strictEqual(claimInfo.data.readUInt8(72), ClaimDecision.Approved);
    assert.strictEqual(claimInfo.data.readUInt16LE(81), 0);

    // — Pending then rejected claim —
    const rejectHash    = crypto.randomBytes(32);
    const rejectAmount  = DEFAULT_THRESHOLD + 5000n;
    const rejectInvoice = await mkInvoice(rejectHash, rejectAmount, "USD");
    const rejectClaim   = getClaimPda(rejectInvoice, insurer.entity.publicKey);
    await mkClaim(rejectInvoice, rejectClaim);

    const reason = 42;
    const rejectIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: insurer.entity.publicKey, isSigner: true, isWritable: true },
        { pubkey: insurer.rolePda, isSigner: false, isWritable: false },
        { pubkey: rejectInvoice, isSigner: false, isWritable: true },
        { pubkey: rejectClaim, isSigner: false, isWritable: true },
      ],
      data: encodeInsurerDecideClaim(false, reason),
    });
    await sendInstruction(connection, [rejectIx], [insurer.entity], insurer.entity.publicKey);

    claimInfo = await connection.getAccountInfo(rejectClaim);
    assert.strictEqual(claimInfo.data.readUInt8(72), ClaimDecision.Rejected);
    assert.strictEqual(claimInfo.data.readUInt16LE(81), reason);
    console.log("Facturation et remboursements testes avec succes");
  });

  // ── 7. Identity, medical records, access audit ────────────────────────────

  it("registers custodial identities, anchors medical records, and logs access", async () => {
    const hospital = await registerAndApproveEntity(connection, payer, configPda, Role.Hospital);
    const patient  = await createPatientProfile(connection, hospital);

    // Admin registers user identity (governance)
    const appUserIdHash  = crypto.randomBytes(32);
    const patientWallet  = anchor.web3.Keypair.generate();
    // Fund accessor so they can pay for AccessEvent PDAs
    await airdrop(connection, patientWallet.publicKey);

    const identityPda = getUserIdentityPda(appUserIdHash);
    const registerIdentityIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: configPda, isSigner: false, isWritable: false },
        { pubkey: identityPda, isSigner: false, isWritable: true },
        { pubkey: anchor.web3.SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: encodeRegisterUserIdentity(appUserIdHash, patientWallet.publicKey, UserRoleClass.Patient),
    });
    await sendInstruction(connection, [registerIdentityIx], [payer], payer.publicKey);

    const identityInfo = await connection.getAccountInfo(identityPda);
    assert(identityInfo, "user identity account not found");
    assert.strictEqual(identityInfo.data.length, USER_IDENTITY_SIZE);
    assert.deepStrictEqual(identityInfo.data.slice(8, 40), appUserIdHash);
    assert(readPubkey(identityInfo.data, 40).equals(patientWallet.publicKey));
    assert.strictEqual(identityInfo.data.readUInt8(72), UserRoleClass.Patient);
    assert.strictEqual(identityInfo.data.readUInt8(73), IdentityStatus.Active);

    // Author (hospital) pays rent for medical record — no admin
    const recordHash  = crypto.randomBytes(32);
    const pointerHash = crypto.randomBytes(32);
    const recordPda   = getMedicalRecordPda(patient.patientPda, recordHash);

    const addRecordIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: hospital.entity.publicKey, isSigner: true, isWritable: true },
        { pubkey: hospital.rolePda, isSigner: false, isWritable: false },
        { pubkey: patient.patientPda, isSigner: false, isWritable: false },
        { pubkey: recordPda, isSigner: false, isWritable: true },
        { pubkey: anchor.web3.SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: encodeAddMedicalRecordAnchor(
        patient.patientIdHash, RecordType.Consultation, recordHash, pointerHash, 1
      ),
    });
    await sendInstruction(connection, [addRecordIx], [hospital.entity], hospital.entity.publicKey);

    let recordInfo = await connection.getAccountInfo(recordPda);
    assert(recordInfo, "medical record account not found");
    assert.strictEqual(recordInfo.data.length, MEDICAL_RECORD_SIZE);
    assert(readPubkey(recordInfo.data, 8).equals(patient.patientPda));
    assert(readPubkey(recordInfo.data, 40).equals(hospital.entity.publicKey));
    assert.strictEqual(recordInfo.data.readUInt8(72), RecordType.Consultation);
    assert.deepStrictEqual(recordInfo.data.slice(73, 105), recordHash);
    assert.deepStrictEqual(recordInfo.data.slice(105, 137), pointerHash);
    assert.strictEqual(recordInfo.data.readUInt32LE(137), 1);
    assert.strictEqual(recordInfo.data.readUInt8(141), RecordStatus.Active);

    // Supersede — no admin
    const replacement = anchor.web3.Keypair.generate().publicKey;
    const supersedeIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: hospital.entity.publicKey, isSigner: true, isWritable: true },
        { pubkey: hospital.rolePda, isSigner: false, isWritable: false },
        { pubkey: recordPda, isSigner: false, isWritable: true },
      ],
      data: encodeSupersedeMedicalRecord(replacement),
    });
    await sendInstruction(connection, [supersedeIx], [hospital.entity], hospital.entity.publicKey);

    recordInfo = await connection.getAccountInfo(recordPda);
    assert.strictEqual(recordInfo.data.readUInt8(141), RecordStatus.Superseded);
    assert(readPubkey(recordInfo.data, 142).equals(replacement));

    // log_access_event — accessor pays, nonce prevents PDA collision
    const nonce = 1;
    const accessEventPda = getAccessEventPda(
      patient.patientPda, patientWallet.publicKey, recordHash, nonce
    );
    const logAccessIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: patientWallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: identityPda, isSigner: false, isWritable: false },
        { pubkey: patient.patientPda, isSigner: false, isWritable: false },
        { pubkey: recordPda, isSigner: false, isWritable: false },
        { pubkey: accessEventPda, isSigner: false, isWritable: true },
        { pubkey: anchor.web3.SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: encodeLogAccessEvent(patient.patientIdHash, AccessKind.Read, recordHash, nonce),
    });
    await sendInstruction(connection, [logAccessIx], [patientWallet], patientWallet.publicKey);

    const accessInfo = await connection.getAccountInfo(accessEventPda);
    assert(accessInfo, "access event account not found");
    assert.strictEqual(accessInfo.data.length, ACCESS_EVENT_SIZE);
    assert(readPubkey(accessInfo.data, 8).equals(patient.patientPda));
    assert(readPubkey(accessInfo.data, 40).equals(patientWallet.publicKey));
    assert(readPubkey(accessInfo.data, 72).equals(recordPda));
    assert.strictEqual(accessInfo.data.readUInt8(104), AccessKind.Read);
    assert.deepStrictEqual(accessInfo.data.slice(105, 137), recordHash);
    // nonce stored at offset 145
    assert.strictEqual(accessInfo.data.readBigUInt64LE(145), BigInt(nonce));

    // Second access with different nonce must succeed (no PDA collision)
    const nonce2 = 2;
    const accessEventPda2 = getAccessEventPda(
      patient.patientPda, patientWallet.publicKey, recordHash, nonce2
    );
    const logAccess2Ix = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: patientWallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: identityPda, isSigner: false, isWritable: false },
        { pubkey: patient.patientPda, isSigner: false, isWritable: false },
        { pubkey: recordPda, isSigner: false, isWritable: false },
        { pubkey: accessEventPda2, isSigner: false, isWritable: true },
        { pubkey: anchor.web3.SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: encodeLogAccessEvent(patient.patientIdHash, AccessKind.Read, recordHash, nonce2),
    });
    await sendInstruction(connection, [logAccess2Ix], [patientWallet], patientWallet.publicKey);

    const accessInfo2 = await connection.getAccountInfo(accessEventPda2);
    assert(accessInfo2, "second access event account not found");
    assert.strictEqual(accessInfo2.data.readBigUInt64LE(145), BigInt(nonce2));

    console.log("Identite custodiale, ancrage medical et audit d'acces testes avec succes");
  });
});
