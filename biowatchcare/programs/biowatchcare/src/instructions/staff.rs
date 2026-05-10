use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::{CLAIM_SEED, CONFIG_SEED, INVOICE_SEED, PATIENT_SEED, ROLE_SEED};
use crate::errors::ErrorCode;
use crate::events::*;
use crate::state::{
    ClaimDecision, ClaimStatus, EntityRole, EntityStatus, GlobalConfig, Invoice, PatientProfile,
    PatientStatus, Role,
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
// create_patient_profile
// ──────────────────────────────────────────────────────────────────────────────
/// Hospital/insurer pays rent for the PatientProfile PDA.
/// Admin no longer co-signs operational instructions.
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
    /// Staff (hospital or insurer) pays rent and signs — no admin required.
    #[account(mut)]
    pub staff: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
    #[account(
        seeds = [ROLE_SEED, staff.key().as_ref()],
        bump = staff_role.bump,
        constraint = staff_role.entity == staff.key()
    )]
    pub staff_role: Account<'info, EntityRole>,
    #[account(
        init,
        payer = staff,
        space = PatientProfile::SPACE,
        seeds = [PATIENT_SEED, patient_id_hash.as_ref()],
        bump
    )]
    pub patient: Account<'info, PatientProfile>,
    pub system_program: Program<'info, System>,
}

// ──────────────────────────────────────────────────────────────────────────────
// create_invoice
// ──────────────────────────────────────────────────────────────────────────────
/// Hospital pays rent. hospital pubkey stored on Invoice for settlement routing.
pub fn create_invoice(
    ctx: Context<CreateInvoice>,
    _patient_id_hash: [u8; 32],
    invoice_hash: [u8; 32],
    amount: u64,
    currency_code: [u8; 3],
) -> Result<()> {
    require_role(&ctx.accounts.hospital_role, &[Role::Hospital])?;
    require!(
        currency_code.iter().all(|b| b.is_ascii_alphabetic()),
        ErrorCode::InvalidCurrencyCode
    );

    let invoice = &mut ctx.accounts.invoice;
    invoice.patient = ctx.accounts.patient.key();
    invoice.invoice_hash = invoice_hash;
    invoice.amount = amount;
    invoice.currency_code = currency_code;
    invoice.created_at = Clock::get()?.unix_timestamp;
    invoice.hospital = ctx.accounts.hospital.key();
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
        payer = hospital,
        space = Invoice::SPACE,
        seeds = [INVOICE_SEED, patient.key().as_ref(), invoice_hash.as_ref()],
        bump
    )]
    pub invoice: Account<'info, Invoice>,
    pub system_program: Program<'info, System>,
}

// ──────────────────────────────────────────────────────────────────────────────
// auto_or_pending_claim
// ──────────────────────────────────────────────────────────────────────────────
/// Hospital pays rent for the ClaimStatus PDA.
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
    claim.settled = false;

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
    pub hospital: Signer<'info>,
    #[account(
        seeds = [ROLE_SEED, hospital.key().as_ref()],
        bump = hospital_role.bump,
        constraint = hospital_role.entity == hospital.key()
    )]
    pub hospital_role: Account<'info, EntityRole>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
    #[account(mut)]
    pub invoice: Account<'info, Invoice>,
    #[account(
        init,
        payer = hospital,
        space = ClaimStatus::SPACE,
        seeds = [CLAIM_SEED, invoice.key().as_ref(), insurer.key().as_ref()],
        bump
    )]
    pub claim: Account<'info, ClaimStatus>,
    /// CHECK: Insurer pubkey used for PDA seed only.
    pub insurer: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

// ──────────────────────────────────────────────────────────────────────────────
// insurer_decide_claim
// ──────────────────────────────────────────────────────────────────────────────
/// Insurer signs alone — no admin, no new account creation.
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

// ──────────────────────────────────────────────────────────────────────────────
// settle_claim
// ──────────────────────────────────────────────────────────────────────────────
/// Execute the SPL token transfer for an Approved claim.
/// Insurer signs and authorises the transfer from their own token account.
/// Payment is routed to the hospital whose pubkey is stored on Invoice.
/// Requires payment_mint to be configured on GlobalConfig.
pub fn settle_claim(ctx: Context<SettleClaim>) -> Result<()> {
    let config = &ctx.accounts.config;
    require!(
        config.payment_mint != Pubkey::default(),
        ErrorCode::PaymentMintNotSet
    );

    let claim = &mut ctx.accounts.claim;
    require!(
        claim.status == ClaimDecision::Approved || claim.status == ClaimDecision::AutoApproved,
        ErrorCode::ClaimNotApproved
    );
    require!(!claim.settled, ErrorCode::ClaimAlreadySettled);
    // The insurer who signed must be the one recorded on the claim.
    require_keys_eq!(claim.insurer, ctx.accounts.insurer.key(), ErrorCode::Unauthorized);

    let amount = ctx.accounts.invoice.amount;

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.insurer_token_account.to_account_info(),
                to: ctx.accounts.hospital_token_account.to_account_info(),
                authority: ctx.accounts.insurer.to_account_info(),
            },
        ),
        amount,
    )?;

    claim.settled = true;

    emit!(ClaimSettled {
        claim: claim.key(),
        insurer: ctx.accounts.insurer.key(),
        amount,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SettleClaim<'info> {
    #[account(mut)]
    pub insurer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
    pub invoice: Account<'info, Invoice>,
    #[account(
        mut,
        seeds = [CLAIM_SEED, invoice.key().as_ref(), insurer.key().as_ref()],
        bump = claim.bump
    )]
    pub claim: Account<'info, ClaimStatus>,
    /// Insurer's SPL token account for the payment mint.
    #[account(
        mut,
        constraint = insurer_token_account.owner == insurer.key() @ ErrorCode::Unauthorized,
        constraint = insurer_token_account.mint == config.payment_mint @ ErrorCode::Unauthorized
    )]
    pub insurer_token_account: Account<'info, TokenAccount>,
    /// Hospital's SPL token account for the payment mint.
    #[account(
        mut,
        constraint = hospital_token_account.owner == invoice.hospital @ ErrorCode::Unauthorized,
        constraint = hospital_token_account.mint == config.payment_mint @ ErrorCode::Unauthorized
    )]
    pub hospital_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}
