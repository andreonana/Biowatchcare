use anchor_lang::prelude::*;

use crate::constants::{
    DISPENSE_SEED, PATIENT_SEED, QR_SEED, ROLE_SEED, RX_SEED, QR_TOKEN_LIFETIME_SECS,
};
use crate::errors::ErrorCode;
use crate::events::*;
use crate::state::{
    Dispense, EntityRole, EntityStatus, PatientProfile, Prescription, QrToken, Role, RxStatus,
};

fn require_role(role_account: &EntityRole, expected: &[Role]) -> Result<()> {
    require!(
        role_account.status == EntityStatus::Approved,
        ErrorCode::RoleNotApproved
    );
    require!(expected.contains(&role_account.role), ErrorCode::InvalidRole);
    Ok(())
}

/// Purpose
/// Create a prescription for a patient.
/// Who signs / Who pays
/// - Signers: admin, doctor
/// - Anchor payer (rent): admin
/// - Transaction fee payer: admin (client-side)
/// Accounts
/// - admin: central payer
/// - doctor: doctor signer
/// - doctor_role: role PDA for doctor
/// - patient: patient profile PDA
/// - prescription: prescription PDA
/// - system_program
/// Preconditions / Access control
/// - doctor_role must be Approved and role Doctor
/// State changes
/// - Create Prescription with Active status
/// Events emitted
/// - PrescriptionCreated
/// Failure modes (ErrorCode)
/// - RoleNotApproved, InvalidRole
/// Security notes
/// - Prescription payload stored off-chain (hash only)
pub fn add_prescription(
    ctx: Context<AddPrescription>,
    patient_id_hash: [u8; 32],
    rx_hash: [u8; 32],
    pointer_hash: [u8; 32],
) -> Result<()> {
    require_role(&ctx.accounts.doctor_role, &[Role::Doctor])?;

    let rx = &mut ctx.accounts.prescription;
    rx.patient = ctx.accounts.patient.key();
    rx.rx_hash = rx_hash;
    rx.doctor = ctx.accounts.doctor.key();
    rx.pointer_hash = pointer_hash;
    rx.created_at = Clock::get()?.unix_timestamp;
    rx.status = RxStatus::Active;
    rx.bump = ctx.bumps.prescription;

    emit!(PrescriptionCreated {
        prescription: rx.key(),
        patient: rx.patient,
        doctor: rx.doctor,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(patient_id_hash: [u8; 32], rx_hash: [u8; 32])]
pub struct AddPrescription<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    pub doctor: Signer<'info>,
    #[account(
        seeds = [ROLE_SEED, doctor.key().as_ref()],
        bump = doctor_role.bump,
        constraint = doctor_role.entity == doctor.key()
    )]
    pub doctor_role: Account<'info, EntityRole>,
    #[account(
        seeds = [PATIENT_SEED, patient_id_hash.as_ref()],
        bump = patient.bump
    )]
    pub patient: Account<'info, PatientProfile>,
    #[account(
        init,
        payer = admin,
        space = Prescription::SPACE,
        seeds = [RX_SEED, patient.key().as_ref(), rx_hash.as_ref()],
        bump
    )]
    pub prescription: Account<'info, Prescription>,
    pub system_program: Program<'info, System>,
}

/// Purpose
/// Cancel an existing prescription.
/// Who signs / Who pays
/// - Signers: admin, doctor
/// - Anchor payer (rent): admin
/// - Transaction fee payer: admin (client-side)
/// Accounts
/// - admin: central payer
/// - doctor: doctor signer
/// - doctor_role: role PDA for doctor
/// - prescription: prescription PDA
/// Preconditions / Access control
/// - doctor_role must be Approved and role Doctor
/// - doctor must match prescription.doctor
/// State changes
/// - Set Prescription status to Cancelled
/// Events emitted
/// - PrescriptionCancelled
/// Failure modes (ErrorCode)
/// - RoleNotApproved, InvalidRole, Unauthorized, RxCancelled
/// Security notes
/// - Cancellation prevents QR issuance and dispense
pub fn cancel_prescription(ctx: Context<CancelPrescription>) -> Result<()> {
    require_role(&ctx.accounts.doctor_role, &[Role::Doctor])?;
    let rx = &mut ctx.accounts.prescription;
    require_keys_eq!(rx.doctor, ctx.accounts.doctor.key(), ErrorCode::Unauthorized);
    require!(rx.status == RxStatus::Active, ErrorCode::RxCancelled);

    rx.status = RxStatus::Cancelled;
    emit!(PrescriptionCancelled {
        prescription: rx.key(),
        doctor: ctx.accounts.doctor.key(),
    });
    Ok(())
}

#[derive(Accounts)]
pub struct CancelPrescription<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    pub doctor: Signer<'info>,
    #[account(
        seeds = [ROLE_SEED, doctor.key().as_ref()],
        bump = doctor_role.bump,
        constraint = doctor_role.entity == doctor.key()
    )]
    pub doctor_role: Account<'info, EntityRole>,
    #[account(mut)]
    pub prescription: Account<'info, Prescription>,
}

/// Purpose
/// Issue a QR token for a prescription.
/// Who signs / Who pays
/// - Signers: admin, doctor
/// - Anchor payer (rent): admin
/// - Transaction fee payer: admin (client-side)
/// Accounts
/// - admin: central payer
/// - doctor: doctor signer
/// - doctor_role: role PDA for doctor
/// - prescription: prescription PDA
/// - qr_token: QR token PDA
/// - system_program
/// Preconditions / Access control
/// - doctor_role must be Approved and role Doctor
/// - prescription must be Active
/// State changes
/// - Create QrToken with 48h expiry
/// Events emitted
/// - QrIssued
/// Failure modes (ErrorCode)
/// - RoleNotApproved, InvalidRole, RxCancelled
/// Security notes
/// - Token hash stored on-chain, payload off-chain
pub fn issue_qr_token(
    ctx: Context<IssueQrToken>,
    token_hash: [u8; 32],
) -> Result<()> {
    require_role(&ctx.accounts.doctor_role, &[Role::Doctor])?;
    require!(
        ctx.accounts.prescription.status == RxStatus::Active,
        ErrorCode::RxCancelled
    );

    let now = Clock::get()?.unix_timestamp;
    let qr = &mut ctx.accounts.qr_token;
    qr.prescription = ctx.accounts.prescription.key();
    qr.token_hash = token_hash;
    qr.expires_at = now + QR_TOKEN_LIFETIME_SECS;
    qr.used = false;
    qr.used_at = 0;
    qr.used_by = Pubkey::default();
    qr.bump = ctx.bumps.qr_token;

    emit!(QrIssued {
        qr: qr.key(),
        prescription: qr.prescription,
        expires_at: qr.expires_at,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct IssueQrToken<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    pub doctor: Signer<'info>,
    #[account(
        seeds = [ROLE_SEED, doctor.key().as_ref()],
        bump = doctor_role.bump,
        constraint = doctor_role.entity == doctor.key()
    )]
    pub doctor_role: Account<'info, EntityRole>,
    #[account(mut)]
    pub prescription: Account<'info, Prescription>,
    #[account(
        init,
        payer = admin,
        space = QrToken::SPACE,
        seeds = [QR_SEED, prescription.key().as_ref(), token_hash.as_ref()],
        bump
    )]
    pub qr_token: Account<'info, QrToken>,
    pub system_program: Program<'info, System>,
}

/// Purpose
/// Verify a QR token without consuming it.
/// Who signs / Who pays
/// - Signers: admin, pharmacist
/// - Anchor payer (rent): admin
/// - Transaction fee payer: admin (client-side)
/// Accounts
/// - admin: central payer
/// - pharmacist: pharmacist signer
/// - pharmacist_role: role PDA for pharmacist
/// - qr_token: QR token PDA
/// Preconditions / Access control
/// - pharmacist_role must be Approved and role Pharmacist
/// State changes
/// - None (read-only)
/// Events emitted
/// - QrVerified
/// Failure modes (ErrorCode)
/// - RoleNotApproved, InvalidRole, QrExpired, QrAlreadyUsed
/// Security notes
/// - Emits validity signal without revealing payload
pub fn verify_qr_token(ctx: Context<VerifyQrToken>) -> Result<()> {
    require_role(&ctx.accounts.pharmacist_role, &[Role::Pharmacist])?;

    let qr = &ctx.accounts.qr_token;
    let now = Clock::get()?.unix_timestamp;

    if qr.expires_at < now {
        emit!(QrVerified {
            qr: qr.key(),
            pharmacist: ctx.accounts.pharmacist.key(),
            valid: false,
        });
        return Err(error!(ErrorCode::QrExpired));
    }

    if qr.used {
        emit!(QrVerified {
            qr: qr.key(),
            pharmacist: ctx.accounts.pharmacist.key(),
            valid: false,
        });
        return Err(error!(ErrorCode::QrAlreadyUsed));
    }

    emit!(QrVerified {
        qr: qr.key(),
        pharmacist: ctx.accounts.pharmacist.key(),
        valid: true,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct VerifyQrToken<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    pub pharmacist: Signer<'info>,
    #[account(
        seeds = [ROLE_SEED, pharmacist.key().as_ref()],
        bump = pharmacist_role.bump,
        constraint = pharmacist_role.entity == pharmacist.key()
    )]
    pub pharmacist_role: Account<'info, EntityRole>,
    pub qr_token: Account<'info, QrToken>,
}

/// Purpose
/// Dispense medication using a valid QR token.
/// Who signs / Who pays
/// - Signers: admin, pharmacist
/// - Anchor payer (rent): admin
/// - Transaction fee payer: admin (client-side)
/// Accounts
/// - admin: central payer
/// - pharmacist: pharmacist signer
/// - pharmacist_role: role PDA for pharmacist
/// - qr_token: QR token PDA (mutable)
/// - dispense: dispense PDA
/// - system_program
/// Preconditions / Access control
/// - pharmacist_role must be Approved and role Pharmacist
/// - qr_token must be valid and unused
/// State changes
/// - Mark QrToken used and create Dispense
/// Events emitted
/// - QrUsed, Dispensed
/// Failure modes (ErrorCode)
/// - RoleNotApproved, InvalidRole, QrExpired, QrAlreadyUsed
/// Security notes
/// - Dispense hash stored off-chain
pub fn dispense_with_qr(
    ctx: Context<DispenseWithQr>,
    dispense_hash: [u8; 32],
) -> Result<()> {
    require_role(&ctx.accounts.pharmacist_role, &[Role::Pharmacist])?;

    let now = Clock::get()?.unix_timestamp;
    let qr = &mut ctx.accounts.qr_token;
    require!(qr.expires_at >= now, ErrorCode::QrExpired);
    require!(!qr.used, ErrorCode::QrAlreadyUsed);

    qr.used = true;
    qr.used_at = now;
    qr.used_by = ctx.accounts.pharmacist.key();

    let dispense = &mut ctx.accounts.dispense;
    dispense.prescription = qr.prescription;
    dispense.pharmacist = ctx.accounts.pharmacist.key();
    dispense.dispense_hash = dispense_hash;
    dispense.created_at = now;
    dispense.bump = ctx.bumps.dispense;

    emit!(QrUsed {
        qr: qr.key(),
        used_by: ctx.accounts.pharmacist.key(),
    });
    emit!(Dispensed {
        dispense: dispense.key(),
        pharmacist: ctx.accounts.pharmacist.key(),
    });
    Ok(())
}

#[derive(Accounts)]
pub struct DispenseWithQr<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    pub pharmacist: Signer<'info>,
    #[account(
        seeds = [ROLE_SEED, pharmacist.key().as_ref()],
        bump = pharmacist_role.bump,
        constraint = pharmacist_role.entity == pharmacist.key()
    )]
    pub pharmacist_role: Account<'info, EntityRole>,
    #[account(mut)]
    pub qr_token: Account<'info, QrToken>,
    #[account(
        init,
        payer = admin,
        space = Dispense::SPACE,
        seeds = [DISPENSE_SEED, qr_token.prescription.as_ref(), pharmacist.key().as_ref()],
        bump
    )]
    pub dispense: Account<'info, Dispense>,
    pub system_program: Program<'info, System>,
}
