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
const CONFIG_SIZE = 57;
const DEFAULT_THRESHOLD = 75000n;
const RPC_URL = process.env.ANCHOR_PROVIDER_URL || "http://127.0.0.1:8899";

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

async function getPayer(connection) {
  const candidates = [
    process.env.ANCHOR_WALLET,
    path.join(os.homedir(), ".config", "solana", "id.json"),
  ];
  for (const candidate of candidates) {
    const keypair = loadKeypairIfExists(candidate);
    if (keypair) {
      return keypair;
    }
  }

  const keypair = anchor.web3.Keypair.generate();
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

describe("biowatchcare", () => {
  it("initializes the config PDA", async () => {
    const connection = new anchor.web3.Connection(RPC_URL, "confirmed");
    const payer = await getPayer(connection);
    const walletPubkey = payer.publicKey;
    const [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [CONFIG_SEED],
      PROGRAM_ID
    );

    const existing = await connection.getAccountInfo(configPda);
    if (!existing) {
      const ix = new anchor.web3.TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: walletPubkey, isSigner: true, isWritable: true },
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
      tx.feePayer = walletPubkey;

      await anchor.web3.sendAndConfirmTransaction(connection, tx, [payer], {
        commitment: "confirmed",
      });
    }

    const info = await connection.getAccountInfo(configPda);
    assert(info, "config account not found");
    assert.strictEqual(info.data.length, CONFIG_SIZE);

    const admin = new anchor.web3.PublicKey(info.data.slice(8, 40));
    if (!existing) {
      assert(admin.equals(walletPubkey));
      const threshold = info.data.readBigUInt64LE(40);
      assert.strictEqual(threshold, DEFAULT_THRESHOLD);
    }
  });
});
