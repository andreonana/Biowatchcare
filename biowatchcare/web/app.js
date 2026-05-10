import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "https://esm.sh/@solana/web3.js@1.98.4";

const CONFIG_SEED = textBytes("config");
const ROLE_SEED = textBytes("role");
const PATIENT_SEED = textBytes("patient");
const CONSENT_SEED = textBytes("consent");
const RX_SEED = textBytes("rx");
const QR_SEED = textBytes("qr");
const DISPENSE_SEED = textBytes("dispense");
const INVOICE_SEED = textBytes("invoice");
const CLAIM_SEED = textBytes("claim");

const STORAGE_KEY = "biowatchcare-mvp-state";
const RECORDS_KEY = "biowatchcare-mvp-records";
const QR_TOKEN_LIFETIME_SECS = 48 * 60 * 60;

const ROLE_LABELS = ["Hospital", "Insurer", "Doctor", "Pharmacist"];
const ENTITY_STATUS = ["Pending", "Approved", "Revoked"];
const PATIENT_STATUS = ["Active"];
const RX_STATUS = ["Active", "Cancelled"];
const CLAIM_STATUS = ["AutoApproved", "Pending", "Approved", "Rejected"];

const state = {
  connection: null,
  provider: null,
  actor: null,
  programId: null,
  adminMode: "wallet",
  adminKeypair: null,
  records: {
    entities: [],
    patients: [],
    prescriptions: [],
    invoices: [],
  },
};

const refs = mapRefs([
  "rpc-url",
  "program-id",
  "actor-wallet",
  "admin-wallet",
  "config-pda",
  "balances",
  "threshold",
  "role-entity",
  "role-kind",
  "role-metadata-hash",
  "entity-name",
  "entity-email",
  "entity-phone",
  "entity-city",
  "entity-address",
  "entity-form-preview",
  "patient-id-hash",
  "patient-name",
  "patient-dob",
  "patient-gender",
  "patient-phone",
  "patient-address",
  "consent-grantee",
  "consent-scopes",
  "consent-expiry",
  "rx-hash",
  "rx-diagnosis",
  "rx-medication",
  "rx-dosage",
  "rx-duration",
  "rx-notes",
  "pointer-hash",
  "token-hash",
  "dispense-hash",
  "invoice-hash",
  "invoice-ref",
  "invoice-service",
  "invoice-notes",
  "invoice-amount",
  "invoice-currency",
  "claim-insurer",
  "claim-approve",
  "claim-reason",
  "config-preview",
  "role-preview",
  "patient-preview",
  "consent-preview",
  "rx-preview",
  "qr-preview",
  "invoice-preview",
  "claim-preview",
  "derived-role",
  "derived-patient",
  "derived-consent",
  "derived-rx",
  "derived-qr",
  "derived-invoice",
  "derived-claim",
  "log-output",
  "mode-wallet",
  "mode-imported",
  "admin-import-panel",
  "admin-secret",
  "admin-secret-file",
  "entity-records",
  "patient-records",
  "rx-records",
  "invoice-records",
]);

function mapRefs(ids) {
  return Object.fromEntries(ids.map((id) => [camel(id), document.getElementById(id)]));
}

function camel(id) {
  return id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function textBytes(value) {
  return new TextEncoder().encode(value);
}

function samePubkey(a, b) {
  return a.toBase58() === b.toBase58();
}

function mergeKeys(keys) {
  const merged = [];
  for (const key of keys) {
    const existing = merged.find((item) => samePubkey(item.pubkey, key.pubkey));
    if (existing) {
      existing.isSigner = existing.isSigner || key.isSigner;
      existing.isWritable = existing.isWritable || key.isWritable;
      continue;
    }
    merged.push({ ...key });
  }
  return merged;
}

function instruction(programId, keys, data) {
  return new TransactionInstruction({
    programId,
    keys: mergeKeys(keys),
    data,
  });
}

function textFromBytes(bytes) {
  return new TextDecoder().decode(bytes);
}

function hexToBytes(hex) {
  const cleaned = hex.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(cleaned)) {
    throw new Error("Le hash doit contenir 64 caracteres hex.");
  }
  return Uint8Array.from(cleaned.match(/.{2}/g).map((part) => Number.parseInt(part, 16)));
}

function bytesToHex(value) {
  return Array.from(value)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function randomHex32() {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

function u16LE(value) {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, Number(value), true);
  return out;
}

function u32LE(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, Number(value), true);
  return out;
}

function u64LE(value) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value), true);
  return out;
}

function i64LE(value) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigInt64(0, BigInt(value), true);
  return out;
}

function optionU64(value) {
  return concat(Uint8Array.of(1), u64LE(value));
}

function concat(...chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function discriminator(name) {
  const payload = textBytes(`global:${name}`);
  const digest = await crypto.subtle.digest("SHA-256", payload);
  return new Uint8Array(digest).slice(0, 8);
}

async function encodeInstruction(name, ...parts) {
  return concat(await discriminator(name), ...parts);
}

async function sha256Hex(input) {
  const payload = typeof input === "string" ? textBytes(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", payload);
  return bytesToHex(new Uint8Array(digest));
}

function log(message, details) {
  const line = `[${new Date().toLocaleTimeString()}] ${message}`;
  refs.logOutput.textContent += details
    ? `${line}\n${JSON.stringify(details, null, 2)}\n\n`
    : `${line}\n\n`;
  refs.logOutput.scrollTop = refs.logOutput.scrollHeight;
}

function nowIso() {
  return new Date().toISOString();
}

function cap(text, max = 48) {
  return text && text.length > max ? `${text.slice(0, max)}...` : text;
}

function renderPreview(element, payload) {
  element.textContent =
    typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
}

async function buildEntityHash() {
  const payload = {
    role: ROLE_LABELS[Number(refs.roleKind.value)],
    legalName: refs.entityName.value.trim(),
    email: refs.entityEmail.value.trim(),
    phone: refs.entityPhone.value.trim(),
    city: refs.entityCity.value.trim(),
    address: refs.entityAddress.value.trim(),
  };
  const hash = await sha256Hex(JSON.stringify(payload));
  refs.roleMetadataHash.value = hash;
  renderPreview(refs.entityFormPreview, { localForm: payload, metadataHash: hash });
  saveLocalState();
  refreshDerivedPdas();
}

async function buildPatientHash() {
  const payload = {
    fullName: refs.patientName.value.trim(),
    dateOfBirth: refs.patientDob.value,
    gender: refs.patientGender.value,
    phone: refs.patientPhone.value.trim(),
    address: refs.patientAddress.value.trim(),
  };
  const hash = await sha256Hex(JSON.stringify(payload));
  refs.patientIdHash.value = hash;
  renderPreview(refs.patientPreview, { localForm: payload, patientIdHash: hash });
  saveLocalState();
  refreshDerivedPdas();
}

async function buildPrescriptionHashes() {
  const rxPayload = {
    diagnosis: refs.rxDiagnosis.value.trim(),
    medication: refs.rxMedication.value.trim(),
    dosage: refs.rxDosage.value.trim(),
    duration: refs.rxDuration.value.trim(),
  };
  const pointerPayload = {
    notes: refs.rxNotes.value.trim(),
    generatedAt: new Date().toISOString(),
  };
  refs.rxHash.value = await sha256Hex(JSON.stringify(rxPayload));
  refs.pointerHash.value = await sha256Hex(JSON.stringify(pointerPayload));
  renderPreview(refs.rxPreview, {
    localForm: rxPayload,
    pointer: pointerPayload,
    rxHash: refs.rxHash.value,
    pointerHash: refs.pointerHash.value,
  });
  saveLocalState();
  refreshDerivedPdas();
}

async function buildInvoiceHash() {
  const payload = {
    reference: refs.invoiceRef.value.trim(),
    service: refs.invoiceService.value.trim(),
    amount: refs.invoiceAmount.value,
    currency: refs.invoiceCurrency.value.trim().toUpperCase(),
    notes: refs.invoiceNotes.value.trim(),
  };
  const hash = await sha256Hex(JSON.stringify(payload));
  refs.invoiceHash.value = hash;
  renderPreview(refs.invoicePreview, { localForm: payload, invoiceHash: hash });
  saveLocalState();
  refreshDerivedPdas();
}

function saveLocalState() {
  const persisted = {
    rpcUrl: refs.rpcUrl.value,
    programId: refs.programId.value,
    threshold: refs.threshold.value,
    roleEntity: refs.roleEntity.value,
    roleKind: refs.roleKind.value,
    roleMetadataHash: refs.roleMetadataHash.value,
    entityName: refs.entityName.value,
    entityEmail: refs.entityEmail.value,
    entityPhone: refs.entityPhone.value,
    entityCity: refs.entityCity.value,
    entityAddress: refs.entityAddress.value,
    patientIdHash: refs.patientIdHash.value,
    patientName: refs.patientName.value,
    patientDob: refs.patientDob.value,
    patientGender: refs.patientGender.value,
    patientPhone: refs.patientPhone.value,
    patientAddress: refs.patientAddress.value,
    consentGrantee: refs.consentGrantee.value,
    consentScopes: refs.consentScopes.value,
    consentExpiry: refs.consentExpiry.value,
    rxHash: refs.rxHash.value,
    rxDiagnosis: refs.rxDiagnosis.value,
    rxMedication: refs.rxMedication.value,
    rxDosage: refs.rxDosage.value,
    rxDuration: refs.rxDuration.value,
    rxNotes: refs.rxNotes.value,
    pointerHash: refs.pointerHash.value,
    tokenHash: refs.tokenHash.value,
    dispenseHash: refs.dispenseHash.value,
    invoiceHash: refs.invoiceHash.value,
    invoiceRef: refs.invoiceRef.value,
    invoiceService: refs.invoiceService.value,
    invoiceNotes: refs.invoiceNotes.value,
    invoiceAmount: refs.invoiceAmount.value,
    invoiceCurrency: refs.invoiceCurrency.value,
    claimInsurer: refs.claimInsurer.value,
    claimApprove: refs.claimApprove.value,
    claimReason: refs.claimReason.value,
    adminMode: state.adminMode,
    adminSecret: refs.adminSecret.value,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
}

function saveRecords() {
  localStorage.setItem(RECORDS_KEY, JSON.stringify(state.records));
}

function loadRecords() {
  const raw = localStorage.getItem(RECORDS_KEY);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    state.records = {
      entities: parsed.entities || [],
      patients: parsed.patients || [],
      prescriptions: parsed.prescriptions || [],
      invoices: parsed.invoices || [],
    };
  } catch {
    state.records = { entities: [], patients: [], prescriptions: [], invoices: [] };
  }
}

function upsertRecord(type, record, identityKey) {
  const list = state.records[type];
  const index = list.findIndex((item) => item[identityKey] === record[identityKey]);
  const next = { ...record, updatedAt: nowIso() };
  if (index >= 0) {
    list[index] = { ...list[index], ...next };
  } else {
    list.unshift(next);
  }
  state.records[type] = list.slice(0, 12);
  saveRecords();
  renderAllRecordLists();
}

function renderRecordList(container, items, renderer) {
  if (!items.length) {
    container.innerHTML = `<div class="empty-records">Aucun dossier local.</div>`;
    return;
  }
  container.innerHTML = items.map(renderer).join("");
}

function renderAllRecordLists() {
  renderRecordList(refs.entityRecords, state.records.entities, (item) => `
    <div class="record-item">
      <div class="record-title">${escapeHtml(item.legalName || item.role || "Entite")}</div>
      <div class="record-meta">${escapeHtml(item.role || "")} / ${escapeHtml(item.entityPubkey || "")}</div>
      <div class="record-actions">
        <button class="compact load-entity" data-id="${escapeAttr(item.entityPubkey)}" type="button">Charger</button>
      </div>
    </div>
  `);

  renderRecordList(refs.patientRecords, state.records.patients, (item) => `
    <div class="record-item">
      <div class="record-title">${escapeHtml(item.fullName || "Patient")}</div>
      <div class="record-meta">${escapeHtml(item.patientIdHash || "")}</div>
      <div class="record-actions">
        <button class="compact load-patient" data-id="${escapeAttr(item.patientIdHash)}" type="button">Charger</button>
      </div>
    </div>
  `);

  renderRecordList(refs.rxRecords, state.records.prescriptions, (item) => `
    <div class="record-item">
      <div class="record-title">${escapeHtml(item.medication || "Ordonnance")}</div>
      <div class="record-meta">${escapeHtml(cap(item.diagnosis || ""))}<br>${escapeHtml(item.rxHash || "")}</div>
      <div class="record-actions">
        <button class="compact load-rx" data-id="${escapeAttr(item.rxHash)}" type="button">Charger</button>
      </div>
    </div>
  `);

  renderRecordList(refs.invoiceRecords, state.records.invoices, (item) => `
    <div class="record-item">
      <div class="record-title">${escapeHtml(item.reference || "Facture")}</div>
      <div class="record-meta">${escapeHtml(item.amount || "")} ${escapeHtml(item.currency || "")}<br>${escapeHtml(item.invoiceHash || "")}</div>
      <div class="record-actions">
        <button class="compact load-invoice" data-id="${escapeAttr(item.invoiceHash)}" type="button">Charger</button>
      </div>
    </div>
  `);

  bindRecordButtons();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("'", "&#39;");
}

function bindRecordButtons() {
  document.querySelectorAll(".load-entity").forEach((button) => {
    button.onclick = () => loadEntityRecord(button.dataset.id);
  });
  document.querySelectorAll(".load-patient").forEach((button) => {
    button.onclick = () => loadPatientRecord(button.dataset.id);
  });
  document.querySelectorAll(".load-rx").forEach((button) => {
    button.onclick = () => loadRxRecord(button.dataset.id);
  });
  document.querySelectorAll(".load-invoice").forEach((button) => {
    button.onclick = () => loadInvoiceRecord(button.dataset.id);
  });
}

function loadEntityRecord(entityPubkey) {
  const item = state.records.entities.find((record) => record.entityPubkey === entityPubkey);
  if (!item) return;
  refs.roleEntity.value = item.entityPubkey || "";
  refs.roleKind.value = String(item.roleIndex ?? 0);
  refs.roleMetadataHash.value = item.metadataHash || "";
  refs.entityName.value = item.legalName || "";
  refs.entityEmail.value = item.email || "";
  refs.entityPhone.value = item.phone || "";
  refs.entityCity.value = item.city || "";
  refs.entityAddress.value = item.address || "";
  renderPreview(refs.entityFormPreview, item);
  saveLocalState();
  refreshDerivedPdas();
}

function loadPatientRecord(patientIdHash) {
  const item = state.records.patients.find((record) => record.patientIdHash === patientIdHash);
  if (!item) return;
  refs.patientIdHash.value = item.patientIdHash || "";
  refs.patientName.value = item.fullName || "";
  refs.patientDob.value = item.dateOfBirth || "";
  refs.patientGender.value = item.gender || "";
  refs.patientPhone.value = item.phone || "";
  refs.patientAddress.value = item.address || "";
  renderPreview(refs.patientPreview, item);
  saveLocalState();
  refreshDerivedPdas();
}

function loadRxRecord(rxHash) {
  const item = state.records.prescriptions.find((record) => record.rxHash === rxHash);
  if (!item) return;
  refs.rxHash.value = item.rxHash || "";
  refs.pointerHash.value = item.pointerHash || "";
  refs.rxDiagnosis.value = item.diagnosis || "";
  refs.rxMedication.value = item.medication || "";
  refs.rxDosage.value = item.dosage || "";
  refs.rxDuration.value = item.duration || "";
  refs.rxNotes.value = item.notes || "";
  renderPreview(refs.rxPreview, item);
  saveLocalState();
  refreshDerivedPdas();
}

function loadInvoiceRecord(invoiceHash) {
  const item = state.records.invoices.find((record) => record.invoiceHash === invoiceHash);
  if (!item) return;
  refs.invoiceHash.value = item.invoiceHash || "";
  refs.invoiceRef.value = item.reference || "";
  refs.invoiceService.value = item.service || "";
  refs.invoiceNotes.value = item.notes || "";
  refs.invoiceAmount.value = item.amount || "";
  refs.invoiceCurrency.value = item.currency || "";
  renderPreview(refs.invoicePreview, item);
  saveLocalState();
  refreshDerivedPdas();
}

function saveEntityRecord() {
  const entity = refs.roleEntity.value.trim() || state.actor?.toBase58() || "";
  upsertRecord("entities", {
    entityPubkey: entity,
    roleIndex: Number(refs.roleKind.value),
    role: ROLE_LABELS[Number(refs.roleKind.value)],
    metadataHash: refs.roleMetadataHash.value.trim(),
    legalName: refs.entityName.value.trim(),
    email: refs.entityEmail.value.trim(),
    phone: refs.entityPhone.value.trim(),
    city: refs.entityCity.value.trim(),
    address: refs.entityAddress.value.trim(),
  }, "entityPubkey");
}

function savePatientRecord() {
  upsertRecord("patients", {
    patientIdHash: refs.patientIdHash.value.trim(),
    fullName: refs.patientName.value.trim(),
    dateOfBirth: refs.patientDob.value,
    gender: refs.patientGender.value,
    phone: refs.patientPhone.value.trim(),
    address: refs.patientAddress.value.trim(),
  }, "patientIdHash");
}

function saveRxRecord() {
  upsertRecord("prescriptions", {
    rxHash: refs.rxHash.value.trim(),
    pointerHash: refs.pointerHash.value.trim(),
    diagnosis: refs.rxDiagnosis.value.trim(),
    medication: refs.rxMedication.value.trim(),
    dosage: refs.rxDosage.value.trim(),
    duration: refs.rxDuration.value.trim(),
    notes: refs.rxNotes.value.trim(),
  }, "rxHash");
}

function saveInvoiceRecord() {
  upsertRecord("invoices", {
    invoiceHash: refs.invoiceHash.value.trim(),
    reference: refs.invoiceRef.value.trim(),
    service: refs.invoiceService.value.trim(),
    notes: refs.invoiceNotes.value.trim(),
    amount: refs.invoiceAmount.value,
    currency: refs.invoiceCurrency.value.trim().toUpperCase(),
  }, "invoiceHash");
}

function clearAllRecords() {
  state.records = { entities: [], patients: [], prescriptions: [], invoices: [] };
  saveRecords();
  renderAllRecordLists();
}

function restoreLocalState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    refs.consentExpiry.value = String(Math.floor(Date.now() / 1000) + 3600);
    return;
  }
  try {
    const data = JSON.parse(raw);
    for (const [key, value] of Object.entries(data)) {
      const ref = refs[key];
      if (ref && typeof value === "string") {
        ref.value = value;
      }
    }
    setAdminMode(data.adminMode === "imported" ? "imported" : "wallet");
  } catch {
    refs.consentExpiry.value = String(Math.floor(Date.now() / 1000) + 3600);
  }
}

function requireConnection() {
  if (!state.connection || !state.programId) {
    throw new Error("Definissez d'abord la connexion RPC et le Program ID.");
  }
}

function requireActor() {
  if (!state.actor) {
    throw new Error("Connectez Phantom pour disposer d'un signataire acteur.");
  }
  return state.actor;
}

function currentAdminPublicKey() {
  if (state.adminMode === "wallet") {
    return requireActor();
  }
  if (!state.adminKeypair) {
    throw new Error("Chargez la cle admin importee.");
  }
  return state.adminKeypair.publicKey;
}

function actorOrFallbackInput(input) {
  const value = input.trim();
  if (!value) {
    return requireActor();
  }
  return new PublicKey(value);
}

function currentTargetEntity() {
  return actorOrFallbackInput(refs.roleEntity.value);
}

function currentPatientHash() {
  if (!refs.patientIdHash.value.trim()) {
    refs.patientIdHash.value = randomHex32();
  }
  return hexToBytes(refs.patientIdHash.value);
}

function currentRxHash() {
  if (!refs.rxHash.value.trim()) {
    refs.rxHash.value = randomHex32();
  }
  return hexToBytes(refs.rxHash.value);
}

function currentTokenHash() {
  if (!refs.tokenHash.value.trim()) {
    refs.tokenHash.value = randomHex32();
  }
  return hexToBytes(refs.tokenHash.value);
}

function currentInvoiceHash() {
  if (!refs.invoiceHash.value.trim()) {
    refs.invoiceHash.value = randomHex32();
  }
  return hexToBytes(refs.invoiceHash.value);
}

function derivePda(seeds) {
  requireConnection();
  return PublicKey.findProgramAddressSync(seeds, state.programId)[0];
}

function getConfigPda() {
  return derivePda([CONFIG_SEED]);
}

function getRolePda(entity) {
  return derivePda([ROLE_SEED, entity.toBytes()]);
}

function getPatientPda(patientHash) {
  return derivePda([PATIENT_SEED, patientHash]);
}

function getConsentPda(patientPda, grantee) {
  return derivePda([CONSENT_SEED, patientPda.toBytes(), grantee.toBytes()]);
}

function getPrescriptionPda(patientPda, rxHash) {
  return derivePda([RX_SEED, patientPda.toBytes(), rxHash]);
}

function getQrPda(prescriptionPda, tokenHash) {
  return derivePda([QR_SEED, prescriptionPda.toBytes(), tokenHash]);
}

function getDispensePda(prescriptionPda, pharmacist) {
  return derivePda([DISPENSE_SEED, prescriptionPda.toBytes(), pharmacist.toBytes()]);
}

function getInvoicePda(patientPda, invoiceHash) {
  return derivePda([INVOICE_SEED, patientPda.toBytes(), invoiceHash]);
}

function getClaimPda(invoicePda, insurer) {
  return derivePda([CLAIM_SEED, invoicePda.toBytes(), insurer.toBytes()]);
}

function readPubkey(data, offset) {
  return new PublicKey(data.slice(offset, offset + 32));
}

function readU64(data, offset) {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(offset, true);
}

function readI64(data, offset) {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigInt64(offset, true);
}

function readU32(data, offset) {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true);
}

function readU16(data, offset) {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(offset, true);
}

function setupConnection() {
  state.connection = new Connection(refs.rpcUrl.value.trim(), "confirmed");
  state.programId = new PublicKey(refs.programId.value.trim());
  refs.configPda.textContent = getConfigPda().toBase58();
  saveLocalState();
  refreshDerivedPdas();
}

async function connectWallet() {
  if (!window.solana?.isPhantom) {
    throw new Error("Phantom n'est pas detecte sur ce navigateur.");
  }
  setupConnection();
  state.provider = window.solana;
  const result = await state.provider.connect();
  state.actor = result.publicKey;
  refs.actorWallet.textContent = state.actor.toBase58();
  if (state.adminMode === "wallet") {
    refs.adminWallet.textContent = state.actor.toBase58();
  }
  if (!refs.roleEntity.value.trim()) {
    refs.roleEntity.placeholder = state.actor.toBase58();
  }
  log("Wallet connecte", {
    actor: state.actor.toBase58(),
    rpc: refs.rpcUrl.value.trim(),
  });
  await refreshBalances();
  refreshDerivedPdas();
}

function setAdminMode(mode) {
  state.adminMode = mode;
  const imported = mode === "imported";
  refs.modeWallet.classList.toggle("is-selected", !imported);
  refs.modeImported.classList.toggle("is-selected", imported);
  refs.adminImportPanel.classList.toggle("hidden", !imported);
  refs.adminWallet.textContent =
    imported && state.adminKeypair
      ? state.adminKeypair.publicKey.toBase58()
      : imported
        ? "admin importe non charge"
        : state.actor
          ? state.actor.toBase58()
          : "wallet connecte requis";
  saveLocalState();
}

function loadAdminFromText(jsonText) {
  const values = JSON.parse(jsonText);
  state.adminKeypair = Keypair.fromSecretKey(Uint8Array.from(values));
  refs.adminWallet.textContent = state.adminKeypair.publicKey.toBase58();
  log("Admin importe charge", { admin: state.adminKeypair.publicKey.toBase58() });
  saveLocalState();
}

async function loadAdminFromFile(file) {
  const text = await file.text();
  refs.adminSecret.value = text;
  loadAdminFromText(text);
}

async function signAndSend(ix, actorRequired) {
  requireConnection();
  const admin = currentAdminPublicKey();
  const tx = new Transaction().add(ix);
  tx.feePayer = admin;
  const latest = await state.connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = latest.blockhash;

  if (state.adminMode === "imported") {
    tx.partialSign(state.adminKeypair);
  }

  const actor = state.actor;
  const walletMustSign =
    !!actor &&
    (actorRequired || state.adminMode === "wallet" || actor.equals(admin));

  let signedTx = tx;
  if (walletMustSign) {
    requireActor();
    signedTx = await state.provider.signTransaction(tx);
  } else if (actorRequired) {
    throw new Error("Cette action requiert un acteur connecte avec Phantom.");
  }

  const signature = await state.connection.sendRawTransaction(
    signedTx.serialize(),
    { skipPreflight: false }
  );

  await state.connection.confirmTransaction(
    { signature, ...latest },
    "confirmed"
  );

  log("Transaction confirmee", {
    signature,
    feePayer: admin.toBase58(),
  });

  await refreshBalances();
  return signature;
}

async function fetchAccount(pubkey) {
  requireConnection();
  const info = await state.connection.getAccountInfo(pubkey, "confirmed");
  if (!info) {
    throw new Error(`Compte absent: ${pubkey.toBase58()}`);
  }
  return info.data;
}

async function refreshBalances() {
  try {
    requireConnection();
    const admin = currentAdminPublicKey();
    const actor = state.actor;
    const adminBalance = await state.connection.getBalance(admin, "confirmed");
    const actorBalance = actor
      ? await state.connection.getBalance(actor, "confirmed")
      : null;
    refs.balances.textContent = actor
      ? `actor ${(actorBalance / LAMPORTS_PER_SOL).toFixed(3)} SOL / admin ${(adminBalance / LAMPORTS_PER_SOL).toFixed(3)} SOL`
      : `admin ${(adminBalance / LAMPORTS_PER_SOL).toFixed(3)} SOL`;
  } catch (error) {
    refs.balances.textContent = error.message;
  }
}

function refreshDerivedPdas() {
  try {
    requireConnection();
    const configPda = getConfigPda();
    refs.configPda.textContent = configPda.toBase58();

    const entity = refs.roleEntity.value.trim() ? new PublicKey(refs.roleEntity.value.trim()) : state.actor;
    refs.derivedRole.textContent = entity ? getRolePda(entity).toBase58() : "-";

    const patientHash = refs.patientIdHash.value.trim() ? hexToBytes(refs.patientIdHash.value) : null;
    const patientPda = patientHash ? getPatientPda(patientHash) : null;
    refs.derivedPatient.textContent = patientPda ? patientPda.toBase58() : "-";

    const grantee = refs.consentGrantee.value.trim() ? new PublicKey(refs.consentGrantee.value.trim()) : null;
    refs.derivedConsent.textContent =
      patientPda && grantee ? getConsentPda(patientPda, grantee).toBase58() : "-";

    const rxHash = refs.rxHash.value.trim() ? hexToBytes(refs.rxHash.value) : null;
    const rxPda = patientPda && rxHash ? getPrescriptionPda(patientPda, rxHash) : null;
    refs.derivedRx.textContent = rxPda ? rxPda.toBase58() : "-";

    const tokenHash = refs.tokenHash.value.trim() ? hexToBytes(refs.tokenHash.value) : null;
    refs.derivedQr.textContent =
      rxPda && tokenHash ? getQrPda(rxPda, tokenHash).toBase58() : "-";

    const invoiceHash = refs.invoiceHash.value.trim() ? hexToBytes(refs.invoiceHash.value) : null;
    const invoicePda = patientPda && invoiceHash ? getInvoicePda(patientPda, invoiceHash) : null;
    refs.derivedInvoice.textContent = invoicePda ? invoicePda.toBase58() : "-";

    const insurer = refs.claimInsurer.value.trim() ? new PublicKey(refs.claimInsurer.value.trim()) : null;
    refs.derivedClaim.textContent =
      invoicePda && insurer ? getClaimPda(invoicePda, insurer).toBase58() : "-";
  } catch {
    refs.derivedRole.textContent = "-";
    refs.derivedPatient.textContent = "-";
    refs.derivedConsent.textContent = "-";
    refs.derivedRx.textContent = "-";
    refs.derivedQr.textContent = "-";
    refs.derivedInvoice.textContent = "-";
    refs.derivedClaim.textContent = "-";
  }
}

async function pingRpc() {
  setupConnection();
  const version = await state.connection.getVersion();
  log("RPC joignable", version);
}

async function readConfig() {
  const pda = getConfigPda();
  const data = await fetchAccount(pda);
  const payload = {
    configPda: pda.toBase58(),
    admin: readPubkey(data, 8).toBase58(),
    threshold: readU64(data, 40).toString(),
    createdAt: readI64(data, 49).toString(),
  };
  renderPreview(refs.configPreview, payload);
  return payload;
}

async function initializeConfig() {
  const admin = currentAdminPublicKey();
  const configPda = getConfigPda();
  const data = await encodeInstruction("initialize_config", optionU64(refs.threshold.value || 0));
  const ix = instruction(state.programId, [
      { pubkey: admin, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ], data);
  await signAndSend(ix, state.adminMode === "wallet");
  await readConfig();
}

async function setThreshold() {
  const admin = currentAdminPublicKey();
  const configPda = getConfigPda();
  const data = await encodeInstruction("set_threshold", u64LE(refs.threshold.value || 0));
  const ix = instruction(state.programId, [
      { pubkey: admin, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
    ], data);
  await signAndSend(ix, state.adminMode === "wallet");
  await readConfig();
}

async function registerRole() {
  const admin = currentAdminPublicKey();
  const entity = currentTargetEntity();
  const rolePda = getRolePda(entity);
  const configPda = getConfigPda();
  if (!refs.roleMetadataHash.value.trim()) {
    refs.roleMetadataHash.value = randomHex32();
  }
  const metadata = hexToBytes(refs.roleMetadataHash.value);
  const data = await encodeInstruction(
    "register_entity",
    Uint8Array.of(Number(refs.roleKind.value)),
    entity.toBytes(),
    metadata
  );
  const ix = instruction(state.programId, [
      { pubkey: admin, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: false },
      { pubkey: rolePda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ], data);
  await signAndSend(ix, state.adminMode === "wallet");
  await readRole();
}

async function roleAdminAction(method) {
  const admin = currentAdminPublicKey();
  const entity = currentTargetEntity();
  const rolePda = getRolePda(entity);
  const configPda = getConfigPda();
  const ix = instruction(state.programId, [
      { pubkey: admin, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: false },
      { pubkey: rolePda, isSigner: false, isWritable: true },
    ], await encodeInstruction(method));
  await signAndSend(ix, state.adminMode === "wallet");
  await readRole();
}

async function readRole() {
  const entity = currentTargetEntity();
  const rolePda = getRolePda(entity);
  const data = await fetchAccount(rolePda);
  const payload = {
    rolePda: rolePda.toBase58(),
    entity: readPubkey(data, 8).toBase58(),
    role: ROLE_LABELS[data[40]] || String(data[40]),
    status: ENTITY_STATUS[data[41]] || String(data[41]),
    metadataHash: bytesToHex(data.slice(42, 74)),
    approvedBy: readPubkey(data, 74).toBase58(),
    updatedAt: readI64(data, 106).toString(),
  };
  renderPreview(refs.rolePreview, payload);
  return payload;
}

async function createPatient() {
  const admin = currentAdminPublicKey();
  const actor = requireActor();
  const patientHash = currentPatientHash();
  const patientPda = getPatientPda(patientHash);
  const configPda = getConfigPda();
  const rolePda = getRolePda(actor);
  const ix = instruction(state.programId, [
      { pubkey: admin, isSigner: true, isWritable: true },
      { pubkey: actor, isSigner: true, isWritable: false },
      { pubkey: configPda, isSigner: false, isWritable: false },
      { pubkey: rolePda, isSigner: false, isWritable: false },
      { pubkey: patientPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ], await encodeInstruction("create_patient_profile", patientHash));
  await signAndSend(ix, true);
  await readPatient();
}

async function readPatient() {
  const patientHash = currentPatientHash();
  const patientPda = getPatientPda(patientHash);
  const data = await fetchAccount(patientPda);
  const payload = {
    patientPda: patientPda.toBase58(),
    patientIdHash: bytesToHex(data.slice(8, 40)),
    status: PATIENT_STATUS[data[40]] || String(data[40]),
    createdBy: readPubkey(data, 41).toBase58(),
    createdAt: readI64(data, 73).toString(),
  };
  renderPreview(refs.patientPreview, payload);
  return payload;
}

async function grantConsent() {
  const admin = currentAdminPublicKey();
  const actor = requireActor();
  const patientHash = currentPatientHash();
  const patientPda = getPatientPda(patientHash);
  const grantee = new PublicKey(refs.consentGrantee.value.trim());
  const consentPda = getConsentPda(patientPda, grantee);
  const scopes = Number(refs.consentScopes.value);
  const expiry = Number(refs.consentExpiry.value || 0);
  const ix = instruction(state.programId, [
      { pubkey: admin, isSigner: true, isWritable: true },
      { pubkey: actor, isSigner: true, isWritable: false },
      { pubkey: patientPda, isSigner: false, isWritable: false },
      { pubkey: consentPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ], await encodeInstruction(
      "grant_consent",
      patientHash,
      grantee.toBytes(),
      u32LE(scopes),
      i64LE(expiry)
    ));
  await signAndSend(ix, true);
  await readConsent();
}

async function revokeConsent() {
  const admin = currentAdminPublicKey();
  const actor = requireActor();
  const patientHash = currentPatientHash();
  const patientPda = getPatientPda(patientHash);
  const grantee = new PublicKey(refs.consentGrantee.value.trim());
  const consentPda = getConsentPda(patientPda, grantee);
  const ix = instruction(state.programId, [
      { pubkey: admin, isSigner: true, isWritable: true },
      { pubkey: actor, isSigner: true, isWritable: false },
      { pubkey: patientPda, isSigner: false, isWritable: false },
      { pubkey: consentPda, isSigner: false, isWritable: true },
    ], await encodeInstruction("revoke_consent", patientHash, grantee.toBytes()));
  await signAndSend(ix, true);
  await readConsent();
}

async function readConsent() {
  const patientHash = currentPatientHash();
  const patientPda = getPatientPda(patientHash);
  const grantee = new PublicKey(refs.consentGrantee.value.trim());
  const consentPda = getConsentPda(patientPda, grantee);
  const data = await fetchAccount(consentPda);
  const payload = {
    consentPda: consentPda.toBase58(),
    patient: readPubkey(data, 8).toBase58(),
    grantee: readPubkey(data, 40).toBase58(),
    scopes: readU32(data, 72),
    expiresAt: readI64(data, 76).toString(),
    revoked: Boolean(data[84]),
  };
  renderPreview(refs.consentPreview, payload);
  return payload;
}

async function addPrescription() {
  const admin = currentAdminPublicKey();
  const actor = requireActor();
  const patientHash = currentPatientHash();
  const patientPda = getPatientPda(patientHash);
  const rxHash = currentRxHash();
  if (!refs.pointerHash.value.trim()) {
    refs.pointerHash.value = randomHex32();
  }
  const pointerHash = hexToBytes(refs.pointerHash.value);
  const prescriptionPda = getPrescriptionPda(patientPda, rxHash);
  const rolePda = getRolePda(actor);
  const ix = instruction(state.programId, [
      { pubkey: admin, isSigner: true, isWritable: true },
      { pubkey: actor, isSigner: true, isWritable: false },
      { pubkey: rolePda, isSigner: false, isWritable: false },
      { pubkey: patientPda, isSigner: false, isWritable: false },
      { pubkey: prescriptionPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ], await encodeInstruction("add_prescription", patientHash, rxHash, pointerHash));
  await signAndSend(ix, true);
  await readPrescription();
}

async function cancelPrescription() {
  const admin = currentAdminPublicKey();
  const actor = requireActor();
  const patientHash = currentPatientHash();
  const patientPda = getPatientPda(patientHash);
  const rxHash = currentRxHash();
  const prescriptionPda = getPrescriptionPda(patientPda, rxHash);
  const rolePda = getRolePda(actor);
  const ix = instruction(state.programId, [
      { pubkey: admin, isSigner: true, isWritable: true },
      { pubkey: actor, isSigner: true, isWritable: false },
      { pubkey: rolePda, isSigner: false, isWritable: false },
      { pubkey: prescriptionPda, isSigner: false, isWritable: true },
    ], await encodeInstruction("cancel_prescription"));
  await signAndSend(ix, true);
  await readPrescription();
}

async function readPrescription() {
  const patientHash = currentPatientHash();
  const patientPda = getPatientPda(patientHash);
  const rxHash = currentRxHash();
  const prescriptionPda = getPrescriptionPda(patientPda, rxHash);
  const data = await fetchAccount(prescriptionPda);
  const payload = {
    prescriptionPda: prescriptionPda.toBase58(),
    patient: readPubkey(data, 8).toBase58(),
    rxHash: bytesToHex(data.slice(40, 72)),
    doctor: readPubkey(data, 72).toBase58(),
    pointerHash: bytesToHex(data.slice(104, 136)),
    createdAt: readI64(data, 136).toString(),
    status: RX_STATUS[data[144]] || String(data[144]),
  };
  renderPreview(refs.rxPreview, payload);
  return payload;
}

async function issueQr() {
  const admin = currentAdminPublicKey();
  const actor = requireActor();
  const patientHash = currentPatientHash();
  const patientPda = getPatientPda(patientHash);
  const rxHash = currentRxHash();
  const tokenHash = currentTokenHash();
  const prescriptionPda = getPrescriptionPda(patientPda, rxHash);
  const qrPda = getQrPda(prescriptionPda, tokenHash);
  const rolePda = getRolePda(actor);
  const ix = instruction(state.programId, [
      { pubkey: admin, isSigner: true, isWritable: true },
      { pubkey: actor, isSigner: true, isWritable: false },
      { pubkey: rolePda, isSigner: false, isWritable: false },
      { pubkey: prescriptionPda, isSigner: false, isWritable: true },
      { pubkey: qrPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ], await encodeInstruction("issue_qr_token", tokenHash));
  await signAndSend(ix, true);
  await readQr();
}

async function verifyQr() {
  const admin = currentAdminPublicKey();
  const actor = requireActor();
  const patientHash = currentPatientHash();
  const patientPda = getPatientPda(patientHash);
  const rxHash = currentRxHash();
  const tokenHash = currentTokenHash();
  const prescriptionPda = getPrescriptionPda(patientPda, rxHash);
  const qrPda = getQrPda(prescriptionPda, tokenHash);
  const rolePda = getRolePda(actor);
  const ix = instruction(state.programId, [
      { pubkey: admin, isSigner: true, isWritable: true },
      { pubkey: actor, isSigner: true, isWritable: false },
      { pubkey: rolePda, isSigner: false, isWritable: false },
      { pubkey: qrPda, isSigner: false, isWritable: false },
    ], await encodeInstruction("verify_qr_token"));
  await signAndSend(ix, true);
  await readQr();
}

async function dispenseQr() {
  const admin = currentAdminPublicKey();
  const actor = requireActor();
  const patientHash = currentPatientHash();
  const patientPda = getPatientPda(patientHash);
  const rxHash = currentRxHash();
  const tokenHash = currentTokenHash();
  if (!refs.dispenseHash.value.trim()) {
    refs.dispenseHash.value = randomHex32();
  }
  const dispenseHash = hexToBytes(refs.dispenseHash.value);
  const prescriptionPda = getPrescriptionPda(patientPda, rxHash);
  const qrPda = getQrPda(prescriptionPda, tokenHash);
  const dispensePda = getDispensePda(prescriptionPda, actor);
  const rolePda = getRolePda(actor);
  const ix = instruction(state.programId, [
      { pubkey: admin, isSigner: true, isWritable: true },
      { pubkey: actor, isSigner: true, isWritable: false },
      { pubkey: rolePda, isSigner: false, isWritable: false },
      { pubkey: qrPda, isSigner: false, isWritable: true },
      { pubkey: dispensePda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ], await encodeInstruction("dispense_with_qr", dispenseHash));
  await signAndSend(ix, true);
  await readQr();
  log("Dispense cree", { dispensePda: dispensePda.toBase58() });
}

async function readQr() {
  const patientHash = currentPatientHash();
  const patientPda = getPatientPda(patientHash);
  const rxHash = currentRxHash();
  const tokenHash = currentTokenHash();
  const prescriptionPda = getPrescriptionPda(patientPda, rxHash);
  const qrPda = getQrPda(prescriptionPda, tokenHash);
  const data = await fetchAccount(qrPda);
  const payload = {
    qrPda: qrPda.toBase58(),
    prescription: readPubkey(data, 8).toBase58(),
    tokenHash: bytesToHex(data.slice(40, 72)),
    expiresAt: readI64(data, 72).toString(),
    lifetimeSeconds: QR_TOKEN_LIFETIME_SECS,
    used: Boolean(data[80]),
    usedAt: readI64(data, 81).toString(),
    usedBy: readPubkey(data, 89).toBase58(),
  };
  renderPreview(refs.qrPreview, payload);
  return payload;
}

async function createInvoice() {
  const admin = currentAdminPublicKey();
  const actor = requireActor();
  const patientHash = currentPatientHash();
  const patientPda = getPatientPda(patientHash);
  const invoiceHash = currentInvoiceHash();
  const rolePda = getRolePda(actor);
  const invoicePda = getInvoicePda(patientPda, invoiceHash);
  const amount = BigInt(refs.invoiceAmount.value || 0);
  const currency = refs.invoiceCurrency.value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error("La devise doit etre exactement 3 lettres.");
  }
  const ix = instruction(state.programId, [
      { pubkey: admin, isSigner: true, isWritable: true },
      { pubkey: actor, isSigner: true, isWritable: false },
      { pubkey: rolePda, isSigner: false, isWritable: false },
      { pubkey: patientPda, isSigner: false, isWritable: false },
      { pubkey: invoicePda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ], await encodeInstruction(
      "create_invoice",
      patientHash,
      invoiceHash,
      u64LE(amount),
      textBytes(currency)
    ));
  await signAndSend(ix, true);
  await readInvoice();
}

async function readInvoice() {
  const patientHash = currentPatientHash();
  const patientPda = getPatientPda(patientHash);
  const invoiceHash = currentInvoiceHash();
  const invoicePda = getInvoicePda(patientPda, invoiceHash);
  const data = await fetchAccount(invoicePda);
  const payload = {
    invoicePda: invoicePda.toBase58(),
    patient: readPubkey(data, 8).toBase58(),
    invoiceHash: bytesToHex(data.slice(40, 72)),
    amount: readU64(data, 72).toString(),
    currency: textFromBytes(data.slice(80, 83)),
    createdAt: readI64(data, 83).toString(),
  };
  renderPreview(refs.invoicePreview, payload);
  return payload;
}

async function autoClaim() {
  const admin = currentAdminPublicKey();
  const actor = requireActor();
  const patientHash = currentPatientHash();
  const patientPda = getPatientPda(patientHash);
  const invoiceHash = currentInvoiceHash();
  const insurer = new PublicKey(refs.claimInsurer.value.trim());
  const invoicePda = getInvoicePda(patientPda, invoiceHash);
  const claimPda = getClaimPda(invoicePda, insurer);
  const rolePda = getRolePda(actor);
  const configPda = getConfigPda();
  const ix = instruction(state.programId, [
      { pubkey: admin, isSigner: true, isWritable: true },
      { pubkey: actor, isSigner: true, isWritable: false },
      { pubkey: rolePda, isSigner: false, isWritable: false },
      { pubkey: configPda, isSigner: false, isWritable: false },
      { pubkey: invoicePda, isSigner: false, isWritable: true },
      { pubkey: claimPda, isSigner: false, isWritable: true },
      { pubkey: insurer, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ], await encodeInstruction("auto_or_pending_claim", insurer.toBytes()));
  await signAndSend(ix, true);
  await readClaim();
}

async function decideClaim() {
  const admin = currentAdminPublicKey();
  const actor = requireActor();
  const patientHash = currentPatientHash();
  const patientPda = getPatientPda(patientHash);
  const invoiceHash = currentInvoiceHash();
  const insurer = new PublicKey(refs.claimInsurer.value.trim());
  const invoicePda = getInvoicePda(patientPda, invoiceHash);
  const claimPda = getClaimPda(invoicePda, insurer);
  const rolePda = getRolePda(actor);
  const approve = refs.claimApprove.value === "true";
  const reasonCode = Number(refs.claimReason.value || 0);
  const ix = instruction(state.programId, [
      { pubkey: admin, isSigner: true, isWritable: true },
      { pubkey: actor, isSigner: true, isWritable: false },
      { pubkey: rolePda, isSigner: false, isWritable: false },
      { pubkey: invoicePda, isSigner: false, isWritable: true },
      { pubkey: claimPda, isSigner: false, isWritable: true },
    ], await encodeInstruction(
      "insurer_decide_claim",
      Uint8Array.of(approve ? 1 : 0),
      u16LE(reasonCode)
    ));
  await signAndSend(ix, true);
  await readClaim();
}

async function readClaim() {
  const patientHash = currentPatientHash();
  const patientPda = getPatientPda(patientHash);
  const invoiceHash = currentInvoiceHash();
  const insurer = new PublicKey(refs.claimInsurer.value.trim());
  const invoicePda = getInvoicePda(patientPda, invoiceHash);
  const claimPda = getClaimPda(invoicePda, insurer);
  const data = await fetchAccount(claimPda);
  const payload = {
    claimPda: claimPda.toBase58(),
    invoice: readPubkey(data, 8).toBase58(),
    insurer: readPubkey(data, 40).toBase58(),
    status: CLAIM_STATUS[data[72]] || String(data[72]),
    decidedAt: readI64(data, 73).toString(),
    reasonCode: readU16(data, 81),
  };
  renderPreview(refs.claimPreview, payload);
  return payload;
}

async function requestAirdrop(kind) {
  requireConnection();
  const pubkey = kind === "admin" ? currentAdminPublicKey() : requireActor();
  const signature = await state.connection.requestAirdrop(pubkey, LAMPORTS_PER_SOL);
  await state.connection.confirmTransaction(signature, "confirmed");
  log("Airdrop recu", { kind, pubkey: pubkey.toBase58(), signature });
  await refreshBalances();
}

function bindTabNavigation() {
  const tabs = Array.from(document.querySelectorAll(".nav-pill"));
  const panels = Array.from(document.querySelectorAll(".tab-panel"));
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((item) => item.classList.toggle("is-active", item === tab));
      panels.forEach((panel) =>
        panel.classList.toggle("is-active", panel.dataset.panel === tab.dataset.tab)
      );
    });
  });
}

function bindPersistence() {
  const inputs = Array.from(document.querySelectorAll("input, select, textarea"));
  inputs.forEach((input) => {
    input.addEventListener("input", () => {
      saveLocalState();
      refreshDerivedPdas();
    });
  });
}

function bindRandomizers() {
  const pairs = [
    ["random-role-hash", refs.roleMetadataHash],
    ["random-patient-hash", refs.patientIdHash],
    ["random-rx-hash", refs.rxHash],
    ["random-pointer-hash", refs.pointerHash],
    ["random-token-hash", refs.tokenHash],
    ["random-dispense-hash", refs.dispenseHash],
    ["random-invoice-hash", refs.invoiceHash],
  ];

  pairs.forEach(([buttonId, input]) => {
    document.getElementById(buttonId).addEventListener("click", () => {
      input.value = randomHex32();
      saveLocalState();
      refreshDerivedPdas();
    });
  });
}

function wrap(label, action) {
  return async () => {
    try {
      await action();
    } catch (error) {
      log(`${label} en echec`, { error: error.message });
      console.error(error);
    }
  };
}

function registerEvents() {
  bindTabNavigation();
  bindPersistence();
  bindRandomizers();

  document.getElementById("connect-wallet").addEventListener("click", wrap("Connexion wallet", connectWallet));
  document.getElementById("ping-rpc").addEventListener("click", wrap("Test RPC", pingRpc));
  document.getElementById("preset-localnet").addEventListener("click", () => {
    refs.rpcUrl.value = "http://127.0.0.1:8899";
    saveLocalState();
    refreshDerivedPdas();
  });
  document.getElementById("preset-devnet").addEventListener("click", () => {
    refs.rpcUrl.value = "https://api.devnet.solana.com";
    saveLocalState();
    refreshDerivedPdas();
  });
  document.getElementById("refresh-state").addEventListener("click", wrap("Rafraichissement", async () => {
    setupConnection();
    await refreshBalances();
    await Promise.allSettled([
      readConfig(),
      refs.roleEntity.value.trim() || state.actor ? readRole() : Promise.resolve(),
    ]);
  }));
  document.getElementById("mode-wallet").addEventListener("click", () => setAdminMode("wallet"));
  document.getElementById("mode-imported").addEventListener("click", () => setAdminMode("imported"));
  document.getElementById("load-admin-secret").addEventListener("click", wrap("Chargement admin", () => loadAdminFromText(refs.adminSecret.value)));
  refs.adminSecretFile.addEventListener("change", wrap("Chargement fichier admin", async () => {
    const [file] = refs.adminSecretFile.files;
    if (!file) return;
    await loadAdminFromFile(file);
  }));

  document.getElementById("read-config").addEventListener("click", wrap("Lecture config", readConfig));
  document.getElementById("initialize-config").addEventListener("click", wrap("initialize_config", initializeConfig));
  document.getElementById("set-threshold").addEventListener("click", wrap("set_threshold", setThreshold));

  document.getElementById("register-role").addEventListener("click", wrap("register_entity", registerRole));
  document.getElementById("build-entity-hash").addEventListener("click", wrap("Generation metadata entite", buildEntityHash));
  document.getElementById("save-entity-record").addEventListener("click", wrap("Sauvegarde entite", async () => saveEntityRecord()));
  document.getElementById("approve-role").addEventListener("click", wrap("approve_entity", () => roleAdminAction("approve_entity")));
  document.getElementById("revoke-role").addEventListener("click", wrap("revoke_entity", () => roleAdminAction("revoke_entity")));
  document.getElementById("read-role").addEventListener("click", wrap("Lecture role", readRole));

  document.getElementById("build-patient-hash").addEventListener("click", wrap("Generation hash patient", buildPatientHash));
  document.getElementById("save-patient-record").addEventListener("click", wrap("Sauvegarde patient", async () => savePatientRecord()));
  document.getElementById("create-patient").addEventListener("click", wrap("create_patient_profile", createPatient));
  document.getElementById("read-patient").addEventListener("click", wrap("Lecture patient", readPatient));
  document.getElementById("grant-consent").addEventListener("click", wrap("grant_consent", grantConsent));
  document.getElementById("revoke-consent").addEventListener("click", wrap("revoke_consent", revokeConsent));
  document.getElementById("read-consent").addEventListener("click", wrap("Lecture consent", readConsent));

  document.getElementById("build-rx-hashes").addEventListener("click", wrap("Generation hashes ordonnance", buildPrescriptionHashes));
  document.getElementById("save-rx-record").addEventListener("click", wrap("Sauvegarde ordonnance", async () => saveRxRecord()));
  document.getElementById("add-rx").addEventListener("click", wrap("add_prescription", addPrescription));
  document.getElementById("cancel-rx").addEventListener("click", wrap("cancel_prescription", cancelPrescription));
  document.getElementById("read-rx").addEventListener("click", wrap("Lecture prescription", readPrescription));
  document.getElementById("issue-qr").addEventListener("click", wrap("issue_qr_token", issueQr));
  document.getElementById("verify-qr").addEventListener("click", wrap("verify_qr_token", verifyQr));
  document.getElementById("dispense-qr").addEventListener("click", wrap("dispense_with_qr", dispenseQr));
  document.getElementById("read-qr").addEventListener("click", wrap("Lecture qr", readQr));

  document.getElementById("build-invoice-hash").addEventListener("click", wrap("Generation hash facture", buildInvoiceHash));
  document.getElementById("save-invoice-record").addEventListener("click", wrap("Sauvegarde facture", async () => saveInvoiceRecord()));
  document.getElementById("create-invoice").addEventListener("click", wrap("create_invoice", createInvoice));
  document.getElementById("read-invoice").addEventListener("click", wrap("Lecture invoice", readInvoice));
  document.getElementById("auto-claim").addEventListener("click", wrap("auto_or_pending_claim", autoClaim));
  document.getElementById("decide-claim").addEventListener("click", wrap("insurer_decide_claim", decideClaim));
  document.getElementById("read-claim").addEventListener("click", wrap("Lecture claim", readClaim));

  document.getElementById("airdrop-actor").addEventListener("click", wrap("Airdrop actor", () => requestAirdrop("actor")));
  document.getElementById("airdrop-admin").addEventListener("click", wrap("Airdrop admin", () => requestAirdrop("admin")));
  document.getElementById("clear-records").addEventListener("click", wrap("Suppression dossiers locaux", async () => clearAllRecords()));
  document.getElementById("clear-log").addEventListener("click", () => {
    refs.logOutput.textContent = "";
  });
}

function boot() {
  restoreLocalState();
  loadRecords();
  registerEvents();
  try {
    setupConnection();
  } catch {
    refs.configPda.textContent = "-";
  }
  if (state.adminMode === "imported" && refs.adminSecret.value.trim()) {
    try {
      loadAdminFromText(refs.adminSecret.value);
    } catch {
      refs.adminWallet.textContent = "admin importe invalide";
    }
  }
  refreshDerivedPdas();
  renderAllRecordLists();
  log("MVP charge. Connectez Phantom, chargez la cle admin si necessaire, puis travaillez par onglet.");
}

boot();
