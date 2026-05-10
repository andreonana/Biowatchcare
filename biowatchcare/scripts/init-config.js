const anchor = require("@coral-xyz/anchor");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_PROGRAM_ID = "E7BWwRFQBYXmNqqAfNPYm1ccgWysJqtJrvUSq1NTnooX";
const PROGRAM_ID = new anchor.web3.PublicKey(
  process.env.PROGRAM_ID || DEFAULT_PROGRAM_ID
);
const CONFIG_SEED = Buffer.from("config");

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
  if (threshold === null || threshold === undefined) {
    return Buffer.concat([disc, Buffer.from([0])]);
  }
  const data = Buffer.alloc(1 + 8);
  data.writeUInt8(1, 0);
  data.writeBigUInt64LE(BigInt(threshold), 1);
  return Buffer.concat([disc, data]);
}

async function main() {
  const url = process.env.ANCHOR_PROVIDER_URL || "http://127.0.0.1:8899";
  const connection = new anchor.web3.Connection(url, "confirmed");
  const payer = await getPayer(connection);

  const [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [CONFIG_SEED],
    PROGRAM_ID
  );

  const existing = await connection.getAccountInfo(configPda);
  if (existing) {
    console.log(`Config already exists: ${configPda.toBase58()}`);
    return;
  }

  const arg = process.argv[2];
  const threshold = arg ? BigInt(arg) : null;

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
    data: encodeInitializeConfig(threshold),
  });

  const tx = new anchor.web3.Transaction().add(ix);
  tx.feePayer = payer.publicKey;

  const signature = await anchor.web3.sendAndConfirmTransaction(
    connection,
    tx,
    [payer],
    { commitment: "confirmed" }
  );

  console.log(`Config initialized: ${configPda.toBase58()}`);
  console.log(`Signature: ${signature}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
