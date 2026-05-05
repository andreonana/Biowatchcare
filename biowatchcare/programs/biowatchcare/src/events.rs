use anchor_lang::prelude::*;

#[event]
pub struct ConfigInitialized {
    pub admin: Pubkey,
    pub threshold: u64,
}

#[event]
pub struct ThresholdUpdated {
    pub admin: Pubkey,
    pub threshold: u64,
}

#[event]
pub struct PaymentMintSet {
    pub admin: Pubkey,
    pub mint: Pubkey,
}

/// Emitted when admin proposes a 2-step transfer of authority.
#[event]
pub struct AdminTransferProposed {
    pub current_admin: Pubkey,
    pub pending_admin: Pubkey,
}

/// Emitted when the pending admin accepts and becomes the new admin.
#[event]
pub struct AdminTransferAccepted {
    pub new_admin: Pubkey,
}

#[event]
pub struct EntityRegistered {
    pub entity: Pubkey,
    pub role: u8,
}

#[event]
pub struct EntityApproved {
    pub entity: Pubkey,
}

#[event]
pub struct EntityRevoked {
    pub entity: Pubkey,
}

#[event]
pub struct PatientCreated {
    pub patient: Pubkey,
    pub created_by: Pubkey,
}

#[event]
pub struct UserIdentityRegistered {
    pub identity: Pubkey,
    pub wallet: Pubkey,
    pub role_class: u8,
}

#[event]
pub struct ConsentGranted {
    pub patient: Pubkey,
    pub grantee: Pubkey,
    pub scopes: u32,
    pub expires_at: i64,
}

/// Emitted when an existing consent is modified (scopes / expiry change).
#[event]
pub struct ConsentUpdated {
    pub patient: Pubkey,
    pub grantee: Pubkey,
    pub scopes: u32,
    pub expires_at: i64,
}

#[event]
pub struct ConsentRevoked {
    pub patient: Pubkey,
    pub grantee: Pubkey,
}

#[event]
pub struct PrescriptionCreated {
    pub prescription: Pubkey,
    pub patient: Pubkey,
    pub doctor: Pubkey,
}

#[event]
pub struct PrescriptionCancelled {
    pub prescription: Pubkey,
    pub doctor: Pubkey,
}

#[event]
pub struct QrIssued {
    pub qr: Pubkey,
    pub prescription: Pubkey,
    pub expires_at: i64,
}

#[event]
pub struct QrVerified {
    pub qr: Pubkey,
    pub pharmacist: Pubkey,
    pub valid: bool,
}

#[event]
pub struct QrUsed {
    pub qr: Pubkey,
    pub used_by: Pubkey,
}

#[event]
pub struct Dispensed {
    pub dispense: Pubkey,
    pub pharmacist: Pubkey,
}

#[event]
pub struct InvoiceCreated {
    pub invoice: Pubkey,
    pub patient: Pubkey,
    pub amount: u64,
}

#[event]
pub struct ClaimAutoApproved {
    pub claim: Pubkey,
    pub insurer: Pubkey,
}

#[event]
pub struct ClaimPending {
    pub claim: Pubkey,
    pub insurer: Pubkey,
}

#[event]
pub struct ClaimApproved {
    pub claim: Pubkey,
    pub insurer: Pubkey,
}

#[event]
pub struct ClaimRejected {
    pub claim: Pubkey,
    pub insurer: Pubkey,
    pub reason_code: u16,
}

/// Emitted when the insurer executes the SPL token transfer for an approved claim.
#[event]
pub struct ClaimSettled {
    pub claim: Pubkey,
    pub insurer: Pubkey,
    pub amount: u64,
}

#[event]
pub struct MedicalRecordAnchored {
    pub record: Pubkey,
    pub patient: Pubkey,
    pub author: Pubkey,
    pub record_type: u8,
}

#[event]
pub struct MedicalRecordSuperseded {
    pub record: Pubkey,
    pub superseded_by: Pubkey,
}

#[event]
pub struct AccessEventLogged {
    pub event: Pubkey,
    pub patient: Pubkey,
    pub accessor: Pubkey,
    pub access_kind: u8,
}

#[event]
pub struct AccessDenied {
    pub actor: Pubkey,
    pub reason: u8,
}
