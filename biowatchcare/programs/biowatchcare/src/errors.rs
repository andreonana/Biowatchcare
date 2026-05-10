use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Caller is not the configured admin")]
    NotAdmin,
    #[msg("Unauthorized operation")]
    Unauthorized,
    #[msg("Entity role not approved")]
    RoleNotApproved,
    #[msg("Invalid role for this instruction")]
    InvalidRole,
    #[msg("Patient profile not found")]
    PatientNotFound,
    #[msg("Consent missing")]
    ConsentMissing,
    #[msg("Consent expired")]
    ConsentExpired,
    #[msg("Consent revoked")]
    ConsentRevoked,
    #[msg("Invalid scopes bitmask")]
    InvalidScopes,
    #[msg("Prescription not found")]
    RxNotFound,
    #[msg("Prescription already cancelled")]
    RxCancelled,
    #[msg("QR token expired")]
    QrExpired,
    #[msg("QR token already used")]
    QrAlreadyUsed,
    #[msg("Invoice not found")]
    InvoiceNotFound,
    #[msg("Claim already decided")]
    ClaimAlreadyDecided,
    #[msg("Amount overflow")]
    AmountOverflow,
    #[msg("Invalid currency code")]
    InvalidCurrencyCode,
    #[msg("Invalid role class")]
    InvalidRoleClass,
    #[msg("User identity inactive")]
    IdentityInactive,
    #[msg("Invalid record type")]
    InvalidRecordType,
    #[msg("Medical record already superseded")]
    RecordAlreadySuperseded,
    #[msg("Invalid record status transition")]
    InvalidRecordStatus,
    // Admin transfer
    #[msg("No pending admin transfer")]
    NoPendingAdminTransfer,
    // Claim settlement
    #[msg("Claim is not in Approved state")]
    ClaimNotApproved,
    #[msg("Claim has already been settled")]
    ClaimAlreadySettled,
    #[msg("Payment mint not configured on GlobalConfig")]
    PaymentMintNotSet,
}
