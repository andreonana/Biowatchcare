use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("FhXSGiUzcvtAVqXM8tyy1HzUf4mFxkUQEvwgmjLRgow3");

#[program]
pub mod biowatchcare {
    use super::*;

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

    pub fn create_patient_profile(
        ctx: Context<CreatePatientProfile>,
        patient_id_hash: [u8; 32],
    ) -> Result<()> {
        instructions::create_patient_profile(ctx, patient_id_hash)
    }

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

    pub fn grant_consent(
        ctx: Context<GrantConsent>,
        patient_id_hash: [u8; 32],
        grantee_pubkey: Pubkey,
        scopes: u32,
        expires_at: i64,
    ) -> Result<()> {
        instructions::grant_consent(ctx, patient_id_hash, grantee_pubkey, scopes, expires_at)
    }

    pub fn revoke_consent(
        ctx: Context<RevokeConsent>,
        patient_id_hash: [u8; 32],
        grantee_pubkey: Pubkey,
    ) -> Result<()> {
        instructions::revoke_consent(ctx, patient_id_hash, grantee_pubkey)
    }

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
}
