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

// ──────────────────────────────────────────────────────────────────────────────
// add_prescription
// ──────────────────────────────────────────────────────────────────────────────
/// Doctor pays own rent. Admin no longer co-signs operational instructions.
pub fn add_prescription(
    ctx: Context<AddPrescription>,
    _patient_id_hash: [u8; 32],
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
    /// Doctor pays rent for the prescription account.
    #[account(mut)]
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
        payer = doctor,
        space = Prescription::SPACE,
        seeds = [RX_SEED, patient.key().as_ref(), rx_hash.as_ref()],
        bump
    )]
    pub prescription: Account<'info, Prescription>,
    pub system_program: Program<'info, System>,
}

// ──────────────────────────────────────────────────────────────────────────────
// cancel_prescription
// ──────────────────────────────────────────────────────────────────────────────
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

// ──────────────────────────────────────────────────────────────────────────────
// issue_qr_token
// ──────────────────────────────────────────────────────────────────────────────
/// Doctor pays rent for the QrToken account.
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
#[instruction(token_hash: [u8; 32])]
pub struct IssueQrToken<'info> {
    #[account(mut)]
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
        payer = doctor,
        space = QrToken::SPACE,
        seeds = [QR_SEED, prescription.key().as_ref(), token_hash.as_ref()],
        bump
    )]
    pub qr_token: Account<'info, QrToken>,
    pub system_program: Program<'info, System>,
}

// ──────────────────────────────────────────────────────────────────────────────
// verify_qr_token  (read-only — no new account)
// ──────────────────────────────────────────────────────────────────────────────
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
    pub pharmacist: Signer<'info>,
    #[account(
        seeds = [ROLE_SEED, pharmacist.key().as_ref()],
        bump = pharmacist_role.bump,
        constraint = pharmacist_role.entity == pharmacist.key()
    )]
    pub pharmacist_role: Account<'info, EntityRole>,
    pub qr_token: Account<'info, QrToken>,
}

// ──────────────────────────────────────────────────────────────────────────────
// dispense_with_qr
// ──────────────────────────────────────────────────────────────────────────────
/// Pharmacist pays rent for the Dispense record and consumes the QR token atomically.
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
        payer = pharmacist,
        space = Dispense::SPACE,
        seeds = [DISPENSE_SEED, qr_token.prescription.as_ref(), pharmacist.key().as_ref()],
        bump
    )]
    pub dispense: Account<'info, Dispense>,
    pub system_program: Program<'info, System>,
}
