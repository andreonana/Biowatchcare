use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("24paEKyzz4aoBDmpdGVyC4Larnp7Bwka95TkgLHoLTiC");

#[program]
pub mod biowatchcare {
    use super::*;

    // ── Admin / Governance ────────────────────────────────────────────────────

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        threshold: Option<u64>,
    ) -> Result<()> {
        instructions::initialize_config(ctx, threshold)
    }

    pub fn set_threshold(
        ctx: Context<SetThreshold>,
        new_threshold: u64,
    ) -> Result<()> {
        instructions::set_threshold(ctx, new_threshold)
    }

    pub fn set_payment_mint(
        ctx: Context<SetPaymentMint>,
        mint: Pubkey,
    ) -> Result<()> {
        instructions::set_payment_mint(ctx, mint)
    }

    /// Step 1: current admin nominates a successor (no authority change yet).
    pub fn propose_admin_transfer(
        ctx: Context<ProposeAdminTransfer>,
        new_admin: Pubkey,
    ) -> Result<()> {
        instructions::propose_admin_transfer(ctx, new_admin)
    }

    /// Step 2: nominated admin accepts and becomes the new admin.
    pub fn accept_admin_transfer(ctx: Context<AcceptAdminTransfer>) -> Result<()> {
        instructions::accept_admin_transfer(ctx)
    }

    pub fn register_entity(
        ctx: Context<RegisterEntity>,
        role: state::Role,
        entity_pubkey: Pubkey,
        metadata_hash: [u8; 32],
    ) -> Result<()> {
        instructions::register_entity(ctx, role, entity_pubkey, metadata_hash)
    }

    pub fn approve_entity(ctx: Context<ApproveEntity>) -> Result<()> {
        instructions::approve_entity(ctx)
    }

    pub fn revoke_entity(ctx: Context<RevokeEntity>) -> Result<()> {
        instructions::revoke_entity(ctx)
    }

    // ── Patient / Consent ─────────────────────────────────────────────────────

    pub fn create_patient_profile(
        ctx: Context<CreatePatientProfile>,
        patient_id_hash: [u8; 32],
    ) -> Result<()> {
        instructions::create_patient_profile(ctx, patient_id_hash)
    }

    /// Create a new Consent PDA. Fails if one already exists — use update_consent.
    pub fn grant_consent(
        ctx: Context<GrantConsent>,
        patient_id_hash: [u8; 32],
        grantee_pubkey: Pubkey,
        scopes: u32,
        expires_at: i64,
    ) -> Result<()> {
        instructions::grant_consent(ctx, patient_id_hash, grantee_pubkey, scopes, expires_at)
    }

    /// Modify an existing Consent PDA (scopes / expiry). Also resets revoked flag.
    pub fn update_consent(
        ctx: Context<UpdateConsent>,
        patient_id_hash: [u8; 32],
        grantee_pubkey: Pubkey,
        scopes: u32,
        expires_at: i64,
    ) -> Result<()> {
        instructions::update_consent(ctx, patient_id_hash, grantee_pubkey, scopes, expires_at)
    }

    pub fn revoke_consent(
        ctx: Context<RevokeConsent>,
        patient_id_hash: [u8; 32],
        grantee_pubkey: Pubkey,
    ) -> Result<()> {
        instructions::revoke_consent(ctx, patient_id_hash, grantee_pubkey)
    }

    // ── Invoices / Claims ─────────────────────────────────────────────────────

    pub fn create_invoice(
        ctx: Context<CreateInvoice>,
        patient_id_hash: [u8; 32],
        invoice_hash: [u8; 32],
        amount: u64,
        currency_code: [u8; 3],
    ) -> Result<()> {
        instructions::create_invoice(ctx, patient_id_hash, invoice_hash, amount, currency_code)
    }

    pub fn auto_or_pending_claim(
        ctx: Context<AutoOrPendingClaim>,
        insurer: Pubkey,
    ) -> Result<()> {
        instructions::auto_or_pending_claim(ctx, insurer)
    }

    pub fn insurer_decide_claim(
        ctx: Context<InsurerDecideClaim>,
        approve: bool,
        reason_code: u16,
    ) -> Result<()> {
        instructions::insurer_decide_claim(ctx, approve, reason_code)
    }

    /// Execute the SPL token transfer for an Approved or AutoApproved claim.
    pub fn settle_claim(ctx: Context<SettleClaim>) -> Result<()> {
        instructions::settle_claim(ctx)
    }

    // ── Prescriptions / QR / Dispense ─────────────────────────────────────────

    pub fn add_prescription(
        ctx: Context<AddPrescription>,
        patient_id_hash: [u8; 32],
        rx_hash: [u8; 32],
        pointer_hash: [u8; 32],
    ) -> Result<()> {
        instructions::add_prescription(ctx, patient_id_hash, rx_hash, pointer_hash)
    }

    pub fn cancel_prescription(ctx: Context<CancelPrescription>) -> Result<()> {
        instructions::cancel_prescription(ctx)
    }

    pub fn issue_qr_token(
        ctx: Context<IssueQrToken>,
        token_hash: [u8; 32],
    ) -> Result<()> {
        instructions::issue_qr_token(ctx, token_hash)
    }

    pub fn verify_qr_token(ctx: Context<VerifyQrToken>) -> Result<()> {
        instructions::verify_qr_token(ctx)
    }

    pub fn dispense_with_qr(
        ctx: Context<DispenseWithQr>,
        dispense_hash: [u8; 32],
    ) -> Result<()> {
        instructions::dispense_with_qr(ctx, dispense_hash)
    }

    // ── Medical Records / Identity / Audit ────────────────────────────────────

    pub fn register_user_identity(
        ctx: Context<RegisterUserIdentity>,
        app_user_id_hash: [u8; 32],
        wallet: Pubkey,
        role_class: state::UserRoleClass,
    ) -> Result<()> {
        instructions::register_user_identity(ctx, app_user_id_hash, wallet, role_class)
    }

    pub fn add_medical_record_anchor(
        ctx: Context<AddMedicalRecordAnchor>,
        patient_id_hash: [u8; 32],
        record_type: state::RecordType,
        record_hash: [u8; 32],
        pointer_hash: [u8; 32],
        version: u32,
    ) -> Result<()> {
        instructions::add_medical_record_anchor(
            ctx,
            patient_id_hash,
            record_type,
            record_hash,
            pointer_hash,
            version,
        )
    }

    pub fn supersede_medical_record(
        ctx: Context<SupersedeMedicalRecord>,
        superseded_by: Pubkey,
    ) -> Result<()> {
        instructions::supersede_medical_record(ctx, superseded_by)
    }

    /// nonce must be unique per (patient, accessor, resource_hash) to avoid PDA collision.
    pub fn log_access_event(
        ctx: Context<LogAccessEvent>,
        patient_id_hash: [u8; 32],
        access_kind: state::AccessKind,
        resource_hash: [u8; 32],
        nonce: u64,
    ) -> Result<()> {
        instructions::log_access_event(ctx, patient_id_hash, access_kind, resource_hash, nonce)
    }
}
