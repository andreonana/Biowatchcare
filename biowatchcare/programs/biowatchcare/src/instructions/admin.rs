use anchor_lang::prelude::*;

use crate::constants::{CONFIG_SEED, ROLE_SEED};
use crate::errors::ErrorCode;
use crate::events::*;
use crate::state::{EntityRole, EntityStatus, GlobalConfig, Role};

// ──────────────────────────────────────────────────────────────────────────────
// initialize_config
// ──────────────────────────────────────────────────────────────────────────────
/// Creates the singleton GlobalConfig PDA. Called once at deploy time.
/// Admin is the sole payer for all governance account creations.
pub fn initialize_config(ctx: Context<InitializeConfig>, threshold: Option<u64>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let config = &mut ctx.accounts.config;
    let bump = ctx.bumps.config;
    config.set_inner(GlobalConfig::new(ctx.accounts.admin.key(), bump, now));
    if let Some(value) = threshold {
        config.auto_reimb_threshold = value;
    }
    emit!(ConfigInitialized {
        admin: config.admin,
        threshold: config.auto_reimb_threshold,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = GlobalConfig::SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, GlobalConfig>,
    pub system_program: Program<'info, System>,
}

// ──────────────────────────────────────────────────────────────────────────────
// set_threshold
// ──────────────────────────────────────────────────────────────────────────────
pub fn set_threshold(ctx: Context<SetThreshold>, new_threshold: u64) -> Result<()> {
    let config = &mut ctx.accounts.config;
    require_keys_eq!(config.admin, ctx.accounts.admin.key(), ErrorCode::NotAdmin);
    config.auto_reimb_threshold = new_threshold;
    emit!(ThresholdUpdated {
        admin: config.admin,
        threshold: new_threshold,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SetThreshold<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
}

// ──────────────────────────────────────────────────────────────────────────────
// set_payment_mint
// ──────────────────────────────────────────────────────────────────────────────
/// Configure the SPL token mint used for claim settlement.
/// Set once after deploying the program; can be updated by admin.
pub fn set_payment_mint(ctx: Context<SetPaymentMint>, mint: Pubkey) -> Result<()> {
    let config = &mut ctx.accounts.config;
    require_keys_eq!(config.admin, ctx.accounts.admin.key(), ErrorCode::NotAdmin);
    config.payment_mint = mint;
    emit!(PaymentMintSet {
        admin: config.admin,
        mint,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SetPaymentMint<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
}

// ──────────────────────────────────────────────────────────────────────────────
// propose_admin_transfer
// ──────────────────────────────────────────────────────────────────────────────
/// Step 1 of 2-step admin hand-off: current admin nominates a successor.
/// No authority change until the successor calls accept_admin_transfer.
pub fn propose_admin_transfer(
    ctx: Context<ProposeAdminTransfer>,
    new_admin: Pubkey,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    require_keys_eq!(config.admin, ctx.accounts.admin.key(), ErrorCode::NotAdmin);
    let current = config.admin;
    config.pending_admin = new_admin;
    emit!(AdminTransferProposed {
        current_admin: current,
        pending_admin: new_admin,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ProposeAdminTransfer<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
}

// ──────────────────────────────────────────────────────────────────────────────
// accept_admin_transfer
// ──────────────────────────────────────────────────────────────────────────────
/// Step 2 of 2-step admin hand-off: the nominated new admin signs to accept.
/// Clears pending_admin after the swap.
pub fn accept_admin_transfer(ctx: Context<AcceptAdminTransfer>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    require!(
        config.pending_admin != Pubkey::default(),
        ErrorCode::NoPendingAdminTransfer
    );
    require_keys_eq!(
        config.pending_admin,
        ctx.accounts.new_admin.key(),
        ErrorCode::Unauthorized
    );
    let new_admin = ctx.accounts.new_admin.key();
    config.admin = new_admin;
    config.pending_admin = Pubkey::default();
    emit!(AdminTransferAccepted { new_admin });
    Ok(())
}

#[derive(Accounts)]
pub struct AcceptAdminTransfer<'info> {
    #[account(mut)]
    pub new_admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
}

// ──────────────────────────────────────────────────────────────────────────────
// register_entity
// ──────────────────────────────────────────────────────────────────────────────
pub fn register_entity(
    ctx: Context<RegisterEntity>,
    role: Role,
    entity_pubkey: Pubkey,
    metadata_hash: [u8; 32],
) -> Result<()> {
    let config = &ctx.accounts.config;
    require_keys_eq!(config.admin, ctx.accounts.admin.key(), ErrorCode::NotAdmin);

    let role_account = &mut ctx.accounts.role_account;
    role_account.entity = entity_pubkey;
    role_account.role = role;
    role_account.status = EntityStatus::Pending;
    role_account.metadata_hash = metadata_hash;
    role_account.approved_by = Pubkey::default();
    role_account.updated_at = Clock::get()?.unix_timestamp;
    role_account.bump = ctx.bumps.role_account;

    emit!(EntityRegistered {
        entity: role_account.entity,
        role: role_account.role as u8,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(role: Role, entity_pubkey: Pubkey)]
pub struct RegisterEntity<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
    #[account(
        init,
        payer = admin,
        space = EntityRole::SPACE,
        seeds = [ROLE_SEED, entity_pubkey.as_ref()],
        bump
    )]
    pub role_account: Account<'info, EntityRole>,
    pub system_program: Program<'info, System>,
}

// ──────────────────────────────────────────────────────────────────────────────
// approve_entity
// ──────────────────────────────────────────────────────────────────────────────
pub fn approve_entity(ctx: Context<ApproveEntity>) -> Result<()> {
    let config = &ctx.accounts.config;
    require_keys_eq!(config.admin, ctx.accounts.admin.key(), ErrorCode::NotAdmin);

    let role_account = &mut ctx.accounts.role_account;
    role_account.status = EntityStatus::Approved;
    role_account.approved_by = ctx.accounts.admin.key();
    role_account.updated_at = Clock::get()?.unix_timestamp;

    emit!(EntityApproved {
        entity: role_account.entity,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ApproveEntity<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
    #[account(mut, seeds = [ROLE_SEED, role_account.entity.as_ref()], bump = role_account.bump)]
    pub role_account: Account<'info, EntityRole>,
}

// ──────────────────────────────────────────────────────────────────────────────
// revoke_entity
// ──────────────────────────────────────────────────────────────────────────────
pub fn revoke_entity(ctx: Context<RevokeEntity>) -> Result<()> {
    let config = &ctx.accounts.config;
    require_keys_eq!(config.admin, ctx.accounts.admin.key(), ErrorCode::NotAdmin);

    let role_account = &mut ctx.accounts.role_account;
    role_account.status = EntityStatus::Revoked;
    role_account.approved_by = ctx.accounts.admin.key();
    role_account.updated_at = Clock::get()?.unix_timestamp;

    emit!(EntityRevoked {
        entity: role_account.entity,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct RevokeEntity<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
    #[account(mut, seeds = [ROLE_SEED, role_account.entity.as_ref()], bump = role_account.bump)]
    pub role_account: Account<'info, EntityRole>,
}
