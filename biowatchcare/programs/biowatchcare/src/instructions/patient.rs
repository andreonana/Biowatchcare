use anchor_lang::prelude::*;

use crate::constants::{CONSENT_SEED, PATIENT_SEED, VIEW_ALL};
use crate::errors::ErrorCode;
use crate::events::*;
use crate::state::{Consent, PatientProfile};

/// Purpose
/// Grant or update consent for a grantee.
/// Who signs / Who pays
/// - Signers: admin, patient
/// - Anchor payer (rent): admin
/// - Transaction fee payer: admin (client-side)
/// Accounts
/// - admin: central payer
/// - patient_signer: patient signer
/// - patient: patient profile PDA
/// - consent: consent PDA
/// - system_program
/// Preconditions / Access control
/// - scopes must be within VIEW_ALL
/// State changes
/// - Create/update Consent with scopes, expiry, revoked=false
/// Events emitted
/// - ConsentGranted
/// Failure modes (ErrorCode)
/// - InvalidScopes
/// Security notes
/// - Patient identity is verified off-chain; on-chain only hashes are stored
pub fn grant_consent(
    ctx: Context<GrantConsent>,
    patient_id_hash: [u8; 32],
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
    #[account(mut)]
    pub admin: Signer<'info>,
    pub patient_signer: Signer<'info>,
    #[account(
        seeds = [PATIENT_SEED, patient_id_hash.as_ref()],
        bump = patient.bump
    )]
    pub patient: Account<'info, PatientProfile>,
    #[account(
        init_if_needed,
        payer = admin,
        space = Consent::SPACE,
        seeds = [CONSENT_SEED, patient.key().as_ref(), grantee_pubkey.as_ref()],
        bump
    )]
    pub consent: Account<'info, Consent>,
    pub system_program: Program<'info, System>,
}

/// Purpose
/// Revoke a consent for a grantee.
/// Who signs / Who pays
/// - Signers: admin, patient
/// - Anchor payer (rent): admin
/// - Transaction fee payer: admin (client-side)
/// Accounts
/// - admin: central payer
/// - patient_signer: patient signer
/// - patient: patient profile PDA
/// - consent: consent PDA
/// Preconditions / Access control
/// - consent must exist
/// State changes
/// - Set consent.revoked = true
/// Events emitted
/// - ConsentRevoked
/// Failure modes (ErrorCode)
/// - ConsentMissing
/// Security notes
/// - Revocation is immediate on-chain
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
    pub admin: Signer<'info>,
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
