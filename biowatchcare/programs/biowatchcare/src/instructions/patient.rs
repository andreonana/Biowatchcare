use anchor_lang::prelude::*;

use crate::constants::{CONSENT_SEED, PATIENT_SEED, VIEW_ALL};
use crate::errors::ErrorCode;
use crate::events::*;
use crate::state::{Consent, PatientProfile};

// ──────────────────────────────────────────────────────────────────────────────
// grant_consent  (creates a new Consent PDA — fails if already exists)
// ──────────────────────────────────────────────────────────────────────────────
/// Patient pays their own rent. No admin co-signature required for patient data.
/// Use update_consent to modify an existing record.
pub fn grant_consent(
    ctx: Context<GrantConsent>,
    _patient_id_hash: [u8; 32],
    grantee_pubkey: Pubkey,
    scopes: u32,
    expires_at: i64,
) -> Result<()> {
    require!((scopes & !VIEW_ALL) == 0 && scopes != 0, ErrorCode::InvalidScopes);

    let consent = &mut ctx.accounts.consent;
    consent.patient = ctx.accounts.patient.key();
    consent.grantee = grantee_pubkey;
    consent.scopes = scopes;
    consent.expires_at = expires_at;
    consent.revoked = false;
    consent.updated_at = Clock::get()?.unix_timestamp;
    consent.bump = ctx.bumps.consent;

    emit!(ConsentGranted {
        patient: consent.patient,
        grantee: grantee_pubkey,
        scopes,
        expires_at,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(patient_id_hash: [u8; 32], grantee_pubkey: Pubkey)]
pub struct GrantConsent<'info> {
    /// Patient signs and pays rent — no admin co-signature.
    #[account(mut)]
    pub patient_signer: Signer<'info>,
    #[account(
        seeds = [PATIENT_SEED, patient_id_hash.as_ref()],
        bump = patient.bump
    )]
    pub patient: Account<'info, PatientProfile>,
    #[account(
        init,
        payer = patient_signer,
        space = Consent::SPACE,
        seeds = [CONSENT_SEED, patient.key().as_ref(), grantee_pubkey.as_ref()],
        bump
    )]
    pub consent: Account<'info, Consent>,
    pub system_program: Program<'info, System>,
}

// ──────────────────────────────────────────────────────────────────────────────
// update_consent  (modifies an existing Consent PDA)
// ──────────────────────────────────────────────────────────────────────────────
/// Replaces init_if_needed: explicit update path avoids silent PDA state bugs.
/// Also resets revoked = false, allowing re-activation with new terms.
pub fn update_consent(
    ctx: Context<UpdateConsent>,
    _patient_id_hash: [u8; 32],
    _grantee_pubkey: Pubkey,
    scopes: u32,
    expires_at: i64,
) -> Result<()> {
    require!((scopes & !VIEW_ALL) == 0 && scopes != 0, ErrorCode::InvalidScopes);

    let consent = &mut ctx.accounts.consent;
    let patient_key = consent.patient;
    let grantee_key = consent.grantee;
    consent.scopes = scopes;
    consent.expires_at = expires_at;
    consent.revoked = false;
    consent.updated_at = Clock::get()?.unix_timestamp;

    emit!(ConsentUpdated {
        patient: patient_key,
        grantee: grantee_key,
        scopes,
        expires_at,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(patient_id_hash: [u8; 32], grantee_pubkey: Pubkey)]
pub struct UpdateConsent<'info> {
    #[account(mut)]
    pub patient_signer: Signer<'info>,
    #[account(
        seeds = [PATIENT_SEED, patient_id_hash.as_ref()],
        bump = patient.bump
    )]
    pub patient: Account<'info, PatientProfile>,
    #[account(
        mut,
        seeds = [CONSENT_SEED, patient.key().as_ref(), grantee_pubkey.as_ref()],
        bump = consent.bump
    )]
    pub consent: Account<'info, Consent>,
}

// ──────────────────────────────────────────────────────────────────────────────
// revoke_consent
// ──────────────────────────────────────────────────────────────────────────────
pub fn revoke_consent(
    ctx: Context<RevokeConsent>,
    _patient_id_hash: [u8; 32],
    grantee_pubkey: Pubkey,
) -> Result<()> {
    let consent = &mut ctx.accounts.consent;
    require!(!consent.revoked, ErrorCode::ConsentRevoked);
    consent.revoked = true;
    consent.updated_at = Clock::get()?.unix_timestamp;

    emit!(ConsentRevoked {
        patient: consent.patient,
        grantee: grantee_pubkey,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(patient_id_hash: [u8; 32], grantee_pubkey: Pubkey)]
pub struct RevokeConsent<'info> {
    #[account(mut)]
    pub patient_signer: Signer<'info>,
    #[account(
        seeds = [PATIENT_SEED, patient_id_hash.as_ref()],
        bump = patient.bump
    )]
    pub patient: Account<'info, PatientProfile>,
    #[account(
        mut,
        seeds = [CONSENT_SEED, patient.key().as_ref(), grantee_pubkey.as_ref()],
        bump = consent.bump
    )]
    pub consent: Account<'info, Consent>,
}
