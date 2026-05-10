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

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum UserRoleClass {
    Patient,
    Practitioner,
    Operator,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum IdentityStatus {
    Active,
    Suspended,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum RecordType {
    Consultation,
    LabResult,
    Imaging,
    Vaccination,
    ClinicalNote,
    ExternalDocument,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum RecordStatus {
    Active,
    Archived,
    Superseded,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum AccessKind {
    Read,
    Write,
    Share,
    Export,
}

/// Global configuration for the BioWatchCare program.
///
/// Space: 8 (disc) + 32 (admin) + 8 (threshold) + 1 (bump) + 8 (created_at)
///      + 32 (pending_admin) + 32 (payment_mint) = 121 bytes.
///
/// pending_admin: non-zero only during a 2-step admin transfer.
/// payment_mint: SPL mint used for claim settlement; Pubkey::default means not configured.
#[account]
pub struct GlobalConfig {
    pub admin: Pubkey,
    pub auto_reimb_threshold: u64,
    pub bump: u8,
    pub created_at: i64,
    pub pending_admin: Pubkey,
    pub payment_mint: Pubkey,
}

impl GlobalConfig {
    pub const SPACE: usize = 8 + 32 + 8 + 1 + 8 + 32 + 32;

    pub fn new(admin: Pubkey, bump: u8, created_at: i64) -> Self {
        Self {
            admin,
            auto_reimb_threshold: DEFAULT_AUTO_REIMB_THRESHOLD,
            bump,
            created_at,
            pending_admin: Pubkey::default(),
            payment_mint: Pubkey::default(),
        }
    }
}

/// Role registry for entities (Hospital, Insurer, Doctor, Pharmacist).
///
/// Space: 8 + 32 + 1 + 1 + 32 + 32 + 8 + 1 = 115 bytes.
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

/// Patient profile keyed by hashed identifier. Identity never stored in plain text.
///
/// Space: 8 + 32 + 1 + 32 + 8 + 1 = 82 bytes.
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

/// App-level user identity linking a hashed app ID to a wallet.
///
/// Space: 8 + 32 + 32 + 1 + 1 + 8 + 8 + 1 = 91 bytes.
#[account]
pub struct UserIdentity {
    pub app_user_id_hash: [u8; 32],
    pub wallet: Pubkey,
    pub role_class: UserRoleClass,
    pub status: IdentityStatus,
    pub created_at: i64,
    pub updated_at: i64,
    pub bump: u8,
}

impl UserIdentity {
    pub const SPACE: usize = 8 + 32 + 32 + 1 + 1 + 8 + 8 + 1;
}

/// Consent record with bitmask scopes for a grantee.
///
/// Space: 8 + 32 + 32 + 4 + 8 + 1 + 8 + 1 = 94 bytes.
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

/// Medical record anchor — data stays off-chain, only hashes on-chain.
///
/// Space: 8 + 32 + 32 + 1 + 32 + 32 + 4 + 1 + 32 + 8 + 8 + 1 = 191 bytes.
#[account]
pub struct MedicalRecordAnchor {
    pub patient: Pubkey,
    pub author: Pubkey,
    pub record_type: RecordType,
    pub record_hash: [u8; 32],
    pub pointer_hash: [u8; 32],
    pub version: u32,
    pub status: RecordStatus,
    pub superseded_by: Pubkey,
    pub created_at: i64,
    pub updated_at: i64,
    pub bump: u8,
}

impl MedicalRecordAnchor {
    pub const SPACE: usize = 8 + 32 + 32 + 1 + 32 + 32 + 4 + 1 + 32 + 8 + 8 + 1;
}

/// Prescription created by an approved doctor.
///
/// Space: 8 + 32 + 32 + 32 + 32 + 8 + 1 + 1 = 146 bytes.
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

/// QR token for a prescription — single-use, valid 48 h.
///
/// Space: 8 + 32 + 32 + 8 + 1 + 8 + 32 + 1 = 122 bytes.
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

/// Dispense record written by a pharmacist when consuming a QR token.
///
/// Space: 8 + 32 + 32 + 32 + 8 + 1 = 113 bytes.
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

/// Invoice created by an approved hospital.
///
/// hospital field is stored so settle_claim can route payment without extra args.
///
/// Space: 8 + 32 + 32 + 8 + 3 + 8 + 32 + 1 = 124 bytes.
#[account]
pub struct Invoice {
    pub patient: Pubkey,
    pub invoice_hash: [u8; 32],
    pub amount: u64,
    pub currency_code: [u8; 3],
    pub created_at: i64,
    pub hospital: Pubkey,
    pub bump: u8,
}

impl Invoice {
    pub const SPACE: usize = 8 + 32 + 32 + 8 + 3 + 8 + 32 + 1;
}

/// Claim decision record.
///
/// settled tracks whether the SPL payment has been executed.
///
/// Space: 8 + 32 + 32 + 1 + 8 + 2 + 1 + 1 = 85 bytes.
#[account]
pub struct ClaimStatus {
    pub invoice: Pubkey,
    pub insurer: Pubkey,
    pub status: ClaimDecision,
    pub decided_at: i64,
    pub reason_code: u16,
    pub bump: u8,
    pub settled: bool,
}

impl ClaimStatus {
    pub const SPACE: usize = 8 + 32 + 32 + 1 + 8 + 2 + 1 + 1;
}

/// Immutable audit record of a data access event.
///
/// nonce in both the seed and the struct prevents PDA collision
/// when the same accessor reads the same resource multiple times.
///
/// Space: 8 + 32 + 32 + 32 + 1 + 32 + 8 + 8 + 1 = 154 bytes.
#[account]
pub struct AccessEvent {
    pub patient: Pubkey,
    pub accessor: Pubkey,
    pub resource: Pubkey,
    pub access_kind: AccessKind,
    pub resource_hash: [u8; 32],
    pub occurred_at: i64,
    pub nonce: u64,
    pub bump: u8,
}

impl AccessEvent {
    pub const SPACE: usize = 8 + 32 + 32 + 32 + 1 + 32 + 8 + 8 + 1;
}
