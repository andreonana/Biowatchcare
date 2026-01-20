use anchor_lang::prelude::*;

use crate::constants::{CLAIM_SEED, CONFIG_SEED, INVOICE_SEED, PATIENT_SEED, ROLE_SEED};
use crate::errors::ErrorCode;
use crate::events::*;
use crate::state::{
    ClaimDecision, ClaimStatus, EntityRole, EntityStatus, Invoice, PatientProfile, PatientStatus,
    Role,
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
/// Create a patient profile keyed by a hashed identifier.
/// Who signs / Who pays
/// - Signers: admin, staff (hospital or insurer)
/// - Anchor payer (rent): admin
/// - Transaction fee payer: admin (client-side)
/// Accounts
/// - admin: central payer
/// - staff: hospital or insurer signer
/// - config: global config PDA
/// - staff_role: role PDA for staff
/// - patient: patient profile PDA
/// - system_program
/// Preconditions / Access control
/// - staff_role must be Approved and role Hospital/Insurer
/// State changes
/// - Create PatientProfile
/// Events emitted
/// - PatientCreated
/// Failure modes (ErrorCode)
/// - RoleNotApproved, InvalidRole
/// Security notes
/// - Patient identity stored only as hash
pub fn create_patient_profile(
    ctx: Context<CreatePatientProfile>,
    patient_id_hash: [u8; 32],
) -> Result<()> {
    require_role(&ctx.accounts.staff_role, &[Role::Hospital, Role::Insurer])?;

    let patient = &mut ctx.accounts.patient;
    patient.patient_id_hash = patient_id_hash;
    patient.status = PatientStatus::Active;
    patient.created_by = ctx.accounts.staff.key();
    patient.created_at = Clock::get()?.unix_timestamp;
    patient.bump = ctx.bumps.patient;

    emit!(PatientCreated {
        patient: patient.key(),
        created_by: ctx.accounts.staff.key(),
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(patient_id_hash: [u8; 32])]
pub struct CreatePatientProfile<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    pub staff: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, crate::state::GlobalConfig>,
    #[account(
        seeds = [ROLE_SEED, staff.key().as_ref()],
        bump = staff_role.bump,
        constraint = staff_role.entity == staff.key()
    )]
    pub staff_role: Account<'info, EntityRole>,
    #[account(
        init,
        payer = admin,
        space = PatientProfile::SPACE,
        seeds = [PATIENT_SEED, patient_id_hash.as_ref()],
        bump
    )]
    pub patient: Account<'info, PatientProfile>,
    pub system_program: Program<'info, System>,
}

/// Purpose
/// Create an invoice for a patient.
/// Who signs / Who pays
/// - Signers: admin, hospital
/// - Anchor payer (rent): admin
/// - Transaction fee payer: admin (client-side)
/// Accounts
/// - admin: central payer
/// - hospital: hospital signer
/// - hospital_role: role PDA for hospital
/// - patient: patient profile PDA
/// - invoice: invoice PDA
/// - system_program
/// Preconditions / Access control
/// - hospital_role must be Approved and role Hospital
/// State changes
/// - Create Invoice
/// Events emitted
/// - InvoiceCreated
/// Failure modes (ErrorCode)
/// - RoleNotApproved, InvalidRole, InvalidCurrencyCode
/// Security notes
/// - Invoice data stored only as hashes and totals
pub fn create_invoice(
    ctx: Context<CreateInvoice>,
    patient_id_hash: [u8; 32],
    invoice_hash: [u8; 32],
    amount: u64,
    currency_code: [u8; 3],
) -> Result<()> {
    require_role(&ctx.accounts.hospital_role, &[Role::Hospital])?;
    require!(currency_code.iter().all(|b| b.is_ascii_alphabetic()), ErrorCode::InvalidCurrencyCode);

    let invoice = &mut ctx.accounts.invoice;
    invoice.patient = ctx.accounts.patient.key();
    invoice.invoice_hash = invoice_hash;
    invoice.amount = amount;
    invoice.currency_code = currency_code;
    invoice.created_at = Clock::get()?.unix_timestamp;
    invoice.bump = ctx.bumps.invoice;

    emit!(InvoiceCreated {
        invoice: invoice.key(),
        patient: invoice.patient,
        amount,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(patient_id_hash: [u8; 32], invoice_hash: [u8; 32])]
pub struct CreateInvoice<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    pub hospital: Signer<'info>,
    #[account(
        seeds = [ROLE_SEED, hospital.key().as_ref()],
        bump = hospital_role.bump,
        constraint = hospital_role.entity == hospital.key()
    )]
    pub hospital_role: Account<'info, EntityRole>,
    #[account(
        seeds = [PATIENT_SEED, patient_id_hash.as_ref()],
        bump = patient.bump
    )]
    pub patient: Account<'info, PatientProfile>,
    #[account(
        init,
        payer = admin,
        space = Invoice::SPACE,
        seeds = [INVOICE_SEED, patient.key().as_ref(), invoice_hash.as_ref()],
        bump
    )]
    pub invoice: Account<'info, Invoice>,
    pub system_program: Program<'info, System>,
}

/// Purpose
/// Create a claim status with auto-approval or pending.
/// Who signs / Who pays
/// - Signers: admin, hospital
/// - Anchor payer (rent): admin
/// - Transaction fee payer: admin (client-side)
/// Accounts
/// - admin: central payer
/// - hospital: hospital signer
/// - hospital_role: role PDA for hospital
/// - config: global config PDA
/// - invoice: invoice PDA
/// - claim: claim status PDA
/// - insurer: insurer account (non-signer)
/// - system_program
/// Preconditions / Access control
/// - hospital_role must be Approved and role Hospital
/// State changes
/// - Create ClaimStatus with AutoApproved or Pending
/// Events emitted
/// - ClaimAutoApproved or ClaimPending
/// Failure modes (ErrorCode)
/// - RoleNotApproved, InvalidRole, AmountOverflow
/// Security notes
/// - Insurer is referenced by pubkey only
pub fn auto_or_pending_claim(
    ctx: Context<AutoOrPendingClaim>,
    insurer: Pubkey,
) -> Result<()> {
    require_role(&ctx.accounts.hospital_role, &[Role::Hospital])?;
    require_keys_eq!(ctx.accounts.insurer.key(), insurer, ErrorCode::Unauthorized);

    let claim = &mut ctx.accounts.claim;
    let now = Clock::get()?.unix_timestamp;
    let threshold = ctx.accounts.config.auto_reimb_threshold;

    claim.invoice = ctx.accounts.invoice.key();
    claim.insurer = insurer;
    claim.bump = ctx.bumps.claim;

    if ctx.accounts.invoice.amount <= threshold {
        claim.status = ClaimDecision::AutoApproved;
        claim.decided_at = now;
        claim.reason_code = 0;
        emit!(ClaimAutoApproved {
            claim: claim.key(),
            insurer,
        });
    } else {
        claim.status = ClaimDecision::Pending;
        claim.decided_at = 0;
        claim.reason_code = 0;
        emit!(ClaimPending {
            claim: claim.key(),
            insurer,
        });
    }
    Ok(())
}

#[derive(Accounts)]
pub struct AutoOrPendingClaim<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    pub hospital: Signer<'info>,
    #[account(
        seeds = [ROLE_SEED, hospital.key().as_ref()],
        bump = hospital_role.bump,
        constraint = hospital_role.entity == hospital.key()
    )]
    pub hospital_role: Account<'info, EntityRole>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, crate::state::GlobalConfig>,
    #[account(mut)]
    pub invoice: Account<'info, Invoice>,
    #[account(
        init,
        payer = admin,
        space = ClaimStatus::SPACE,
        seeds = [CLAIM_SEED, invoice.key().as_ref(), insurer.key().as_ref()],
        bump
    )]
    pub claim: Account<'info, ClaimStatus>,
    /// CHECK: Insurer pubkey used for PDA seed only.
    pub insurer: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Purpose
/// Insurer decides on a pending claim.
/// Who signs / Who pays
/// - Signers: admin, insurer
/// - Anchor payer (rent): admin
/// - Transaction fee payer: admin (client-side)
/// Accounts
/// - admin: central payer
/// - insurer: insurer signer
/// - insurer_role: role PDA for insurer
/// - invoice: invoice PDA
/// - claim: claim status PDA
/// Preconditions / Access control
/// - insurer_role must be Approved and role Insurer
/// - claim must be Pending
/// State changes
/// - Update ClaimStatus status and decided_at
/// Events emitted
/// - ClaimApproved or ClaimRejected
/// Failure modes (ErrorCode)
/// - RoleNotApproved, InvalidRole, ClaimAlreadyDecided
/// Security notes
/// - Reason code should map to off-chain policy
pub fn insurer_decide_claim(
    ctx: Context<InsurerDecideClaim>,
    approve: bool,
    reason_code: u16,
) -> Result<()> {
    require_role(&ctx.accounts.insurer_role, &[Role::Insurer])?;

    let claim = &mut ctx.accounts.claim;
    require!(claim.status == ClaimDecision::Pending, ErrorCode::ClaimAlreadyDecided);

    claim.status = if approve {
        ClaimDecision::Approved
    } else {
        ClaimDecision::Rejected
    };
    claim.decided_at = Clock::get()?.unix_timestamp;
    claim.reason_code = if approve { 0 } else { reason_code };

    if approve {
        emit!(ClaimApproved {
            claim: claim.key(),
            insurer: ctx.accounts.insurer.key(),
        });
    } else {
        emit!(ClaimRejected {
            claim: claim.key(),
            insurer: ctx.accounts.insurer.key(),
            reason_code,
        });
    }
    Ok(())
}

#[derive(Accounts)]
pub struct InsurerDecideClaim<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    pub insurer: Signer<'info>,
    #[account(
        seeds = [ROLE_SEED, insurer.key().as_ref()],
        bump = insurer_role.bump,
        constraint = insurer_role.entity == insurer.key()
    )]
    pub insurer_role: Account<'info, EntityRole>,
    #[account(mut)]
    pub invoice: Account<'info, Invoice>,
    #[account(
        mut,
        seeds = [CLAIM_SEED, invoice.key().as_ref(), insurer.key().as_ref()],
        bump = claim.bump
    )]
    pub claim: Account<'info, ClaimStatus>,
}
