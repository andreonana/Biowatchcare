use anchor_lang::prelude::*;

use crate::constants::DEFAULT_AUTO_REIMB_THRESHOLD;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Hospital,
    Insurer,
    Doctor,
    Pharmacist,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum EntityStatus {
    Pending,
    Approved,
    Revoked,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum PatientStatus {
    Active,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum RxStatus {
    Active,
    Cancelled,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum ClaimDecision {
    AutoApproved,
    Pending,
    Approved,
    Rejected,
}

/// Global configuration for the BioWatchCare program.
///
/// Invariants:
/// - admin is the sole authority for admin-only instructions.
/// - auto_reimb_threshold governs automatic claim decisions.
///
/// Space calculation:
/// 8 (discriminator) + 32 (admin) + 8 (auto_reimb_threshold) + 1 (bump) + 8 (created_at) = 57 bytes.
///
/// Fields:
/// - admin: central payer and authority.
/// - auto_reimb_threshold: max amount for auto-approval.
/// - bump: PDA bump.
/// - created_at: unix timestamp.
#[account]
pub struct GlobalConfig {
    pub admin: Pubkey,
    pub auto_reimb_threshold: u64,
    pub bump: u8,
    pub created_at: i64,
}

impl GlobalConfig {
    pub const SPACE: usize = 8 + 32 + 8 + 1 + 8;

    pub fn new(admin: Pubkey, bump: u8, created_at: i64) -> Self {
        Self {
            admin,
            auto_reimb_threshold: DEFAULT_AUTO_REIMB_THRESHOLD,
            bump,
            created_at,
        }
    }
}

/// Role registry for entities that can interact with medical data.
///
/// Invariants:
/// - entity must be unique for a given role PDA.
/// - status must be Approved to perform privileged actions.
///
/// Space calculation:
/// 8 (discriminator) + 32 (entity) + 1 (role) + 1 (status) + 32 (metadata_hash)
/// + 32 (approved_by) + 8 (updated_at) + 1 (bump) = 115 bytes.
///
/// Fields:
/// - entity: public key of the hospital/insurer/doctor/pharmacist.
/// - role: Role enum.
/// - status: EntityStatus enum.
/// - metadata_hash: off-chain metadata pointer hash.
/// - approved_by: admin key that approved/revoked.
/// - updated_at: unix timestamp.
/// - bump: PDA bump.
#[account]
pub struct EntityRole {
    pub entity: Pubkey,
    pub role: Role,
    pub status: EntityStatus,
    pub metadata_hash: [u8; 32],
    pub approved_by: Pubkey,
    pub updated_at: i64,
    pub bump: u8,
}

impl EntityRole {
    pub const SPACE: usize = 8 + 32 + 1 + 1 + 32 + 32 + 8 + 1;
}

/// Patient profile keyed by a hashed identifier.
///
/// Invariants:
/// - patient_id_hash is immutable.
/// - only approved hospitals/insurers can create profiles.
///
/// Space calculation:
/// 8 (discriminator) + 32 (patient_id_hash) + 1 (status) + 32 (created_by)
/// + 8 (created_at) + 1 (bump) = 82 bytes.
///
/// Fields:
/// - patient_id_hash: hash of patient identifier.
/// - status: PatientStatus enum.
/// - created_by: hospital/insurer that created the profile.
/// - created_at: unix timestamp.
/// - bump: PDA bump.
#[account]
pub struct PatientProfile {
    pub patient_id_hash: [u8; 32],
    pub status: PatientStatus,
    pub created_by: Pubkey,
    pub created_at: i64,
    pub bump: u8,
}

impl PatientProfile {
    pub const SPACE: usize = 8 + 32 + 1 + 32 + 8 + 1;
}

/// Consent record defining access scopes for a grantee.
///
/// Invariants:
/// - patient and grantee are immutable.
/// - scopes is a bitmask of allowed permissions.
///
/// Space calculation:
/// 8 (discriminator) + 32 (patient) + 32 (grantee) + 4 (scopes) + 8 (expires_at)
/// + 1 (revoked) + 8 (updated_at) + 1 (bump) = 94 bytes.
///
/// Fields:
/// - patient: patient profile PDA.
/// - grantee: entity receiving access.
/// - scopes: bitmask of scopes.
/// - expires_at: unix timestamp (0 means no expiry).
/// - revoked: revocation flag.
/// - updated_at: unix timestamp.
/// - bump: PDA bump.
#[account]
pub struct Consent {
    pub patient: Pubkey,
    pub grantee: Pubkey,
    pub scopes: u32,
    pub expires_at: i64,
    pub revoked: bool,
    pub updated_at: i64,
    pub bump: u8,
}

impl Consent {
    pub const SPACE: usize = 8 + 32 + 32 + 4 + 8 + 1 + 8 + 1;
}

/// Prescription record created by an approved doctor.
///
/// Invariants:
/// - rx_hash and patient are immutable.
/// - status transitions from Active to Cancelled only.
///
/// Space calculation:
/// 8 (discriminator) + 32 (patient) + 32 (rx_hash) + 32 (doctor) + 32 (pointer_hash)
/// + 8 (created_at) + 1 (status) + 1 (bump) = 146 bytes.
///
/// Fields:
/// - patient: patient profile PDA.
/// - rx_hash: hash of prescription.
/// - doctor: doctor signer.
/// - pointer_hash: off-chain pointer hash.
/// - created_at: unix timestamp.
/// - status: RxStatus enum.
/// - bump: PDA bump.
#[account]
pub struct Prescription {
    pub patient: Pubkey,
    pub rx_hash: [u8; 32],
    pub doctor: Pubkey,
    pub pointer_hash: [u8; 32],
    pub created_at: i64,
    pub status: RxStatus,
    pub bump: u8,
}

impl Prescription {
    pub const SPACE: usize = 8 + 32 + 32 + 32 + 32 + 8 + 1 + 1;
}

/// QR token issued for a prescription, valid for 48h.
///
/// Invariants:
/// - expires_at is immutable.
/// - used can only move from false to true.
///
/// Space calculation:
/// 8 (discriminator) + 32 (prescription) + 32 (token_hash) + 8 (expires_at) + 1 (used)
/// + 8 (used_at) + 32 (used_by) + 1 (bump) = 122 bytes.
///
/// Fields:
/// - prescription: prescription PDA.
/// - token_hash: hash of QR token.
/// - expires_at: unix timestamp.
/// - used: usage flag.
/// - used_at: unix timestamp when used.
/// - used_by: pharmacist that used it.
/// - bump: PDA bump.
#[account]
pub struct QrToken {
    pub prescription: Pubkey,
    pub token_hash: [u8; 32],
    pub expires_at: i64,
    pub used: bool,
    pub used_at: i64,
    pub used_by: Pubkey,
    pub bump: u8,
}

impl QrToken {
    pub const SPACE: usize = 8 + 32 + 32 + 8 + 1 + 8 + 32 + 1;
}

/// Dispense record created by a pharmacist when a QR token is used.
///
/// Invariants:
/// - prescription and pharmacist are immutable.
///
/// Space calculation:
/// 8 (discriminator) + 32 (prescription) + 32 (pharmacist) + 32 (dispense_hash)
/// + 8 (created_at) + 1 (bump) = 113 bytes.
///
/// Fields:
/// - prescription: prescription PDA.
/// - pharmacist: pharmacist signer.
/// - dispense_hash: hash of dispense record.
/// - created_at: unix timestamp.
/// - bump: PDA bump.
#[account]
pub struct Dispense {
    pub prescription: Pubkey,
    pub pharmacist: Pubkey,
    pub dispense_hash: [u8; 32],
    pub created_at: i64,
    pub bump: u8,
}

impl Dispense {
    pub const SPACE: usize = 8 + 32 + 32 + 32 + 8 + 1;
}

/// Invoice record created by an approved hospital.
///
/// Invariants:
/// - invoice_hash and patient are immutable.
/// - amount must fit within u64.
///
/// Space calculation:
/// 8 (discriminator) + 32 (patient) + 32 (invoice_hash) + 8 (amount) + 3 (currency_code)
/// + 8 (created_at) + 1 (bump) = 92 bytes.
///
/// Fields:
/// - patient: patient profile PDA.
/// - invoice_hash: hash of invoice document.
/// - amount: invoice amount.
/// - currency_code: ISO currency code bytes.
/// - created_at: unix timestamp.
/// - bump: PDA bump.
#[account]
pub struct Invoice {
    pub patient: Pubkey,
    pub invoice_hash: [u8; 32],
    pub amount: u64,
    pub currency_code: [u8; 3],
    pub created_at: i64,
    pub bump: u8,
}

impl Invoice {
    pub const SPACE: usize = 8 + 32 + 32 + 8 + 3 + 8 + 1;
}

/// Claim status record for insurer decisions.
///
/// Invariants:
/// - invoice and insurer are immutable.
/// - status can transition from Pending to Approved/Rejected only once.
///
/// Space calculation:
/// 8 (discriminator) + 32 (invoice) + 32 (insurer) + 1 (status) + 8 (decided_at)
/// + 2 (reason_code) + 1 (bump) = 84 bytes.
///
/// Fields:
/// - invoice: invoice PDA.
/// - insurer: insurer public key.
/// - status: ClaimDecision enum.
/// - decided_at: unix timestamp.
/// - reason_code: insurer rejection reason code.
/// - bump: PDA bump.
#[account]
pub struct ClaimStatus {
    pub invoice: Pubkey,
    pub insurer: Pubkey,
    pub status: ClaimDecision,
    pub decided_at: i64,
    pub reason_code: u16,
    pub bump: u8,
}

impl ClaimStatus {
    pub const SPACE: usize = 8 + 32 + 32 + 1 + 8 + 2 + 1;
}
