use anchor_lang::prelude::*;

use crate::constants::{CONFIG_SEED, DEFAULT_AUTO_REIMB_THRESHOLD, ROLE_SEED};
use crate::errors::ErrorCode;
use crate::events::*;
use crate::state::{EntityRole, EntityStatus, GlobalConfig, Role};

/// Purpose
/// Initialize the global configuration PDA.
/// Who signs / Who pays
/// - Signers: admin
/// - Anchor payer (rent): admin
/// - Transaction fee payer: admin (client-side)
/// Accounts
/// - admin: central payer and authority
/// - config: global config PDA
/// - system_program
/// Preconditions / Access control
/// - Config must not already exist
/// State changes
/// - Create and populate GlobalConfig
/// Events emitted
/// - ConfigInitialized
/// Failure modes (ErrorCode)
/// - None
/// Security notes
/// - Admin must be kept in secure custody (KMS/HSM/Vault)
pub fn initialize_config(ctx: Context<InitializeConfig>, threshold: Option<u64>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let config = &mut ctx.accounts.config;
    let bump = ctx.bumps.config;
    *config = GlobalConfig::new(ctx.accounts.admin.key(), bump, now);
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

/// Purpose
/// Update the auto reimbursement threshold.
/// Who signs / Who pays
/// - Signers: admin
/// - Anchor payer (rent): admin
/// - Transaction fee payer: admin (client-side)
/// Accounts
/// - admin: central authority
/// - config: global config PDA
/// Preconditions / Access control
/// - admin must match config.admin
/// State changes
/// - Update config.auto_reimb_threshold
/// Events emitted
/// - ThresholdUpdated
/// Failure modes (ErrorCode)
/// - NotAdmin
/// Security notes
/// - Keep admin signer isolated from app keys
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

/// Purpose
/// Register an entity role (pending approval).
/// Who signs / Who pays
/// - Signers: admin
/// - Anchor payer (rent): admin
/// - Transaction fee payer: admin (client-side)
/// Accounts
/// - admin: central authority
/// - config: global config PDA
/// - role_account: role PDA for entity
/// - system_program
/// Preconditions / Access control
/// - admin must match config.admin
/// State changes
/// - Create EntityRole with Pending status
/// Events emitted
/// - EntityRegistered
/// Failure modes (ErrorCode)
/// - NotAdmin
/// Security notes
/// - Metadata is stored as hash only
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

/// Purpose
/// Approve an entity role.
/// Who signs / Who pays
/// - Signers: admin
/// - Anchor payer (rent): admin
/// - Transaction fee payer: admin (client-side)
/// Accounts
/// - admin: central authority
/// - config: global config PDA
/// - role_account: entity role PDA
/// Preconditions / Access control
/// - admin must match config.admin
/// State changes
/// - Set status Approved and updated_at
/// Events emitted
/// - EntityApproved
/// Failure modes (ErrorCode)
/// - NotAdmin
/// Security notes
/// - Only admin can approve
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

/// Purpose
/// Revoke an entity role.
/// Who signs / Who pays
/// - Signers: admin
/// - Anchor payer (rent): admin
/// - Transaction fee payer: admin (client-side)
/// Accounts
/// - admin: central authority
/// - config: global config PDA
/// - role_account: entity role PDA
/// Preconditions / Access control
/// - admin must match config.admin
/// State changes
/// - Set status Revoked and updated_at
/// Events emitted
/// - EntityRevoked
/// Failure modes (ErrorCode)
/// - NotAdmin
/// Security notes
/// - Revocation is immediate and on-chain
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
