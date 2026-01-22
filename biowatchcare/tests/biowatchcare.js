const assert = require("assert");
const anchor = require("@coral-xyz/anchor");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PROGRAM_ID = new anchor.web3.PublicKey(
  "FhXSGiUzcvtAVqXM8tyy1HzUf4mFxkUQEvwgmjLRgow3"
);
const CONFIG_SEED = Buffer.from("config");
const ROLE_SEED = Buffer.from("role");

const CONFIG_SIZE = 57;
const ENTITY_ROLE_SIZE = 115;
const DEFAULT_THRESHOLD = 75000n;
const RPC_URL = process.env.ANCHOR_PROVIDER_URL || "http://127.0.0.1:8899";

const Role = {
  Hospital: 0,
  Insurer: 1,
  Doctor: 2,
  Pharmacist: 3,
};

const EntityStatus = {
  Pending: 0,
  Approved: 1,
  Revoked: 2,
};

function expandHome(inputPath) {
  if (inputPath.startsWith("~")) {
    return path.join(os.homedir(), inputPath.slice(1));
  }
  return inputPath;
}

function loadKeypairIfExists(keypairPath) {
  if (!keypairPath) {
    return null;
  }
  const fullPath = expandHome(keypairPath);
  if (!fs.existsSync(fullPath)) {
    return null;
  }
  const secret = Uint8Array.from(JSON.parse(fs.readFileSync(fullPath, "utf8")));
  return anchor.web3.Keypair.fromSecretKey(secret);
}

async function getPayer(connection, allowAirdrop = true) {
  const localFallback = path.join(process.cwd(), ".anchor", "localnet-admin.json");
  const candidates = [
    process.env.ANCHOR_WALLET,
    path.join(os.homedir(), ".config", "solana", "id.json"),
    localFallback,
  ];
  for (const candidate of candidates) {
    const keypair = loadKeypairIfExists(candidate);
    if (keypair) {
      return keypair;
    }
  }

  if (!allowAirdrop) {
    return null;
  }

  const keypair = anchor.web3.Keypair.generate();
  fs.mkdirSync(path.dirname(localFallback), { recursive: true });
  fs.writeFileSync(
    localFallback,
    JSON.stringify(Array.from(keypair.secretKey)),
    "utf8"
  );
  const sig = await connection.requestAirdrop(
    keypair.publicKey,
    2 * anchor.web3.LAMPORTS_PER_SOL
  );
  await connection.confirmTransaction(sig, "confirmed");
  return keypair;
}

function discriminator(name) {
  return crypto
    .createHash("sha256")
    .update(`global:${name}`)
    .digest()
    .subarray(0, 8);
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

function encodeRegisterEntity(role, entityPubkey, metadataHash) {
  const disc = discriminator("register_entity");
  const data = Buffer.alloc(1 + 32 + 32);
  data.writeUInt8(role, 0);
  entityPubkey.toBuffer().copy(data, 1);
  metadataHash.copy(data, 33);
  return Buffer.concat([disc, data]);
}

function encodeNoArgs(name) {
  return discriminator(name);
}

function readPubkey(data, offset) {
  return new anchor.web3.PublicKey(data.slice(offset, offset + 32));
}

function getConfigPda() {
  return anchor.web3.PublicKey.findProgramAddressSync([CONFIG_SEED], PROGRAM_ID)[0];
}

async function getConfigInfo(connection) {
  const configPda = getConfigPda();
  const info = await connection.getAccountInfo(configPda);
  const admin = info ? readPubkey(info.data, 8) : null;
  return { configPda, info, admin };
}

async function createConfig(connection, payer) {
  const [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [CONFIG_SEED],
    PROGRAM_ID
  );
  const ix = new anchor.web3.TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
      {
        pubkey: anchor.web3.SystemProgram.programId,
        isSigner: false,
        isWritable: false,
      },
    ],
    data: encodeInitializeConfig(DEFAULT_THRESHOLD),
  });

  const tx = new anchor.web3.Transaction().add(ix);
  tx.feePayer = payer.publicKey;

  await anchor.web3.sendAndConfirmTransaction(connection, tx, [payer], {
    commitment: "confirmed",
  });
}

describe("biowatchcare", () => {
  it("initializes the config PDA if missing", async () => {
    const connection = new anchor.web3.Connection(RPC_URL, "confirmed");
    let { info } = await getConfigInfo(connection);
    if (!info) {
      const payer = await getPayer(connection, true);
      await createConfig(connection, payer);
      ({ info } = await getConfigInfo(connection));
      const admin = readPubkey(info.data, 8);
      assert(admin.equals(payer.publicKey));
      const threshold = info.data.readBigUInt64LE(40);
      assert.strictEqual(threshold, DEFAULT_THRESHOLD);
    }

    assert(info, "config account not found");
    assert.strictEqual(info.data.length, CONFIG_SIZE);
  });

  it("sets the reimbursement threshold", async function () {
    const connection = new anchor.web3.Connection(RPC_URL, "confirmed");
    let payer = await getPayer(connection, false);
    let { configPda, info, admin } = await getConfigInfo(connection);

    if (!info) {
      payer = payer || (await getPayer(connection, true));
      await createConfig(connection, payer);
      ({ configPda, info, admin } = await getConfigInfo(connection));
    }

    if (!payer || !admin.equals(payer.publicKey)) {
      this.skip();
    }

    const newThreshold = DEFAULT_THRESHOLD + 123n;
    const ix = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: configPda, isSigner: false, isWritable: true },
      ],
      data: encodeSetThreshold(newThreshold),
    });

    const tx = new anchor.web3.Transaction().add(ix);
    tx.feePayer = payer.publicKey;
    await anchor.web3.sendAndConfirmTransaction(connection, tx, [payer], {
      commitment: "confirmed",
    });

    const updatedInfo = await connection.getAccountInfo(configPda);
    assert(updatedInfo, "config account not found");
    const storedThreshold = updatedInfo.data.readBigUInt64LE(40);
    assert.strictEqual(storedThreshold, newThreshold);
  });

  it("registers, approves, and revokes an entity role", async function () {
    const connection = new anchor.web3.Connection(RPC_URL, "confirmed");
    let payer = await getPayer(connection, false);
    let { configPda, info, admin } = await getConfigInfo(connection);

    if (!info) {
      payer = payer || (await getPayer(connection, true));
      await createConfig(connection, payer);
      ({ configPda, info, admin } = await getConfigInfo(connection));
    }

    if (!payer || !admin.equals(payer.publicKey)) {
      this.skip();
    }

    const entity = anchor.web3.Keypair.generate();
    const metadataHash = crypto.randomBytes(32);
    const [rolePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [ROLE_SEED, entity.publicKey.toBuffer()],
      PROGRAM_ID
    );

    const registerIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: configPda, isSigner: false, isWritable: false },
        { pubkey: rolePda, isSigner: false, isWritable: true },
        {
          pubkey: anchor.web3.SystemProgram.programId,
          isSigner: false,
          isWritable: false,
        },
      ],
      data: encodeRegisterEntity(Role.Doctor, entity.publicKey, metadataHash),
    });

    const registerTx = new anchor.web3.Transaction().add(registerIx);
    registerTx.feePayer = payer.publicKey;
    await anchor.web3.sendAndConfirmTransaction(connection, registerTx, [payer], {
      commitment: "confirmed",
    });

    let roleInfo = await connection.getAccountInfo(rolePda);
    assert(roleInfo, "role account not found");
    assert.strictEqual(roleInfo.data.length, ENTITY_ROLE_SIZE);
    const storedEntity = readPubkey(roleInfo.data, 8);
    const storedRole = roleInfo.data.readUInt8(40);
    const storedStatus = roleInfo.data.readUInt8(41);
    assert(storedEntity.equals(entity.publicKey));
    assert.strictEqual(storedRole, Role.Doctor);
    assert.strictEqual(storedStatus, EntityStatus.Pending);

    const approveIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: configPda, isSigner: false, isWritable: false },
        { pubkey: rolePda, isSigner: false, isWritable: true },
      ],
      data: encodeNoArgs("approve_entity"),
    });

    const approveTx = new anchor.web3.Transaction().add(approveIx);
    approveTx.feePayer = payer.publicKey;
    await anchor.web3.sendAndConfirmTransaction(connection, approveTx, [payer], {
      commitment: "confirmed",
    });

    roleInfo = await connection.getAccountInfo(rolePda);
    const approvedStatus = roleInfo.data.readUInt8(41);
    const approvedBy = readPubkey(roleInfo.data, 74);
    assert.strictEqual(approvedStatus, EntityStatus.Approved);
    assert(approvedBy.equals(payer.publicKey));

    const revokeIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: configPda, isSigner: false, isWritable: false },
        { pubkey: rolePda, isSigner: false, isWritable: true },
      ],
      data: encodeNoArgs("revoke_entity"),
    });

    const revokeTx = new anchor.web3.Transaction().add(revokeIx);
    revokeTx.feePayer = payer.publicKey;
    await anchor.web3.sendAndConfirmTransaction(connection, revokeTx, [payer], {
      commitment: "confirmed",
    });

    roleInfo = await connection.getAccountInfo(rolePda);
    const revokedStatus = roleInfo.data.readUInt8(41);
    const revokedBy = readPubkey(roleInfo.data, 74);
    assert.strictEqual(revokedStatus, EntityStatus.Revoked);
    assert(revokedBy.equals(payer.publicKey));
  });
});
