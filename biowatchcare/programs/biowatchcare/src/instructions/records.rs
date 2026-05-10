use anchor_lang::prelude::*;

use crate::constants::{
    ACCESS_EVENT_SEED, CONFIG_SEED, PATIENT_SEED, RECORD_SEED, ROLE_SEED, USER_IDENTITY_SEED,
};
use crate::errors::ErrorCode;
use crate::events::*;
use crate::state::{
    AccessEvent, AccessKind, EntityRole, EntityStatus, GlobalConfig, IdentityStatus,
    MedicalRecordAnchor, PatientProfile, RecordStatus, RecordType, Role, UserIdentity,
    UserRoleClass,
};

fn require_practitioner_role(role_account: &EntityRole) -> Result<()> {
    require!(
        role_account.status == EntityStatus::Approved,
        ErrorCode::RoleNotApproved
    );
    require!(
        matches!(role_account.role, Role::Hospital | Role::Doctor),
        ErrorCode::InvalidRole
    );
    Ok(())
}

// ──────────────────────────────────────────────────────────────────────────────
// register_user_identity  (governance — admin pays and signs)
// ──────────────────────────────────────────────────────────────────────────────
pub fn register_user_identity(
    ctx: Context<RegisterUserIdentity>,
    app_user_id_hash: [u8; 32],
    wallet: Pubkey,
    role_class: UserRoleClass,
) -> Result<()> {
    let config = &ctx.accounts.config;
    require_keys_eq!(config.admin, ctx.accounts.admin.key(), ErrorCode::NotAdmin);

    let now = Clock::get()?.unix_timestamp;
    let identity = &mut ctx.accounts.user_identity;
    identity.app_user_id_hash = app_user_id_hash;
    identity.wallet = wallet;
    identity.role_class = role_class;
    identity.status = IdentityStatus::Active;
    identity.created_at = now;
    identity.updated_at = now;
    identity.bump = ctx.bumps.user_identity;

    emit!(UserIdentityRegistered {
        identity: identity.key(),
        wallet,
        role_class: role_class as u8,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(app_user_id_hash: [u8; 32])]
pub struct RegisterUserIdentity<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
    #[account(
        init,
        payer = admin,
        space = UserIdentity::SPACE,
        seeds = [USER_IDENTITY_SEED, app_user_id_hash.as_ref()],
        bump
    )]
    pub user_identity: Account<'info, UserIdentity>,
    pub system_program: Program<'info, System>,
}

// ──────────────────────────────────────────────────────────────────────────────
// add_medical_record_anchor
// ──────────────────────────────────────────────────────────────────────────────
/// Author (doctor or hospital) pays rent — no admin co-signature.
pub fn add_medical_record_anchor(
    ctx: Context<AddMedicalRecordAnchor>,
    _patient_id_hash: [u8; 32],
    record_type: RecordType,
    record_hash: [u8; 32],
    pointer_hash: [u8; 32],
    version: u32,
) -> Result<()> {
    require_practitioner_role(&ctx.accounts.author_role)?;

    let now = Clock::get()?.unix_timestamp;
    let record = &mut ctx.accounts.record;
    record.patient = ctx.accounts.patient.key();
    record.author = ctx.accounts.author.key();
    record.record_type = record_type;
    record.record_hash = record_hash;
    record.pointer_hash = pointer_hash;
    record.version = version;
    record.status = RecordStatus::Active;
    record.superseded_by = Pubkey::default();
    record.created_at = now;
    record.updated_at = now;
    record.bump = ctx.bumps.record;

    emit!(MedicalRecordAnchored {
        record: record.key(),
        patient: record.patient,
        author: record.author,
        record_type: record_type as u8,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(
    patient_id_hash: [u8; 32],
    record_type: RecordType,
    record_hash: [u8; 32],
    pointer_hash: [u8; 32],
    version: u32
)]
pub struct AddMedicalRecordAnchor<'info> {
    #[account(mut)]
    pub author: Signer<'info>,
    #[account(
        seeds = [ROLE_SEED, author.key().as_ref()],
        bump = author_role.bump,
        constraint = author_role.entity == author.key()
    )]
    pub author_role: Account<'info, EntityRole>,
    #[account(
        seeds = [PATIENT_SEED, patient_id_hash.as_ref()],
        bump = patient.bump
    )]
    pub patient: Account<'info, PatientProfile>,
    #[account(
        init,
        payer = author,
        space = MedicalRecordAnchor::SPACE,
        seeds = [RECORD_SEED, patient.key().as_ref(), record_hash.as_ref()],
        bump
    )]
    pub record: Account<'info, MedicalRecordAnchor>,
    pub system_program: Program<'info, System>,
}

// ──────────────────────────────────────────────────────────────────────────────
// supersede_medical_record
// ──────────────────────────────────────────────────────────────────────────────
pub fn supersede_medical_record(
    ctx: Context<SupersedeMedicalRecord>,
    superseded_by: Pubkey,
) -> Result<()> {
    require_practitioner_role(&ctx.accounts.author_role)?;

    let record = &mut ctx.accounts.record;
    require!(
        record.status == RecordStatus::Active,
        ErrorCode::RecordAlreadySuperseded
    );
    require_keys_eq!(record.author, ctx.accounts.author.key(), ErrorCode::Unauthorized);

    record.status = RecordStatus::Superseded;
    record.superseded_by = superseded_by;
    record.updated_at = Clock::get()?.unix_timestamp;

    emit!(MedicalRecordSuperseded {
        record: record.key(),
        superseded_by,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SupersedeMedicalRecord<'info> {
    #[account(mut)]
    pub author: Signer<'info>,
    #[account(
        seeds = [ROLE_SEED, author.key().as_ref()],
        bump = author_role.bump,
        constraint = author_role.entity == author.key()
    )]
    pub author_role: Account<'info, EntityRole>,
    #[account(mut)]
    pub record: Account<'info, MedicalRecordAnchor>,
}

// ──────────────────────────────────────────────────────────────────────────────
// log_access_event
// ──────────────────────────────────────────────────────────────────────────────
/// nonce is included in the PDA seed to allow multiple access events for the
/// same (patient, accessor, resource_hash) tuple without collision.
/// Caller supplies a monotonic counter or a random u64.
pub fn log_access_event(
    ctx: Context<LogAccessEvent>,
    _patient_id_hash: [u8; 32],
    access_kind: AccessKind,
    resource_hash: [u8; 32],
    nonce: u64,
) -> Result<()> {
    let identity = &ctx.accounts.user_identity;
    require!(
        identity.status == IdentityStatus::Active,
        ErrorCode::IdentityInactive
    );
    require_keys_eq!(identity.wallet, ctx.accounts.accessor.key(), ErrorCode::Unauthorized);

    let event = &mut ctx.accounts.access_event;
    event.patient = ctx.accounts.patient.key();
    event.accessor = ctx.accounts.accessor.key();
    event.resource = ctx.accounts.resource.key();
    event.access_kind = access_kind;
    event.resource_hash = resource_hash;
    event.occurred_at = Clock::get()?.unix_timestamp;
    event.nonce = nonce;
    event.bump = ctx.bumps.access_event;

    emit!(AccessEventLogged {
        event: event.key(),
        patient: event.patient,
        accessor: event.accessor,
        access_kind: access_kind as u8,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(
    patient_id_hash: [u8; 32],
    access_kind: AccessKind,
    resource_hash: [u8; 32],
    nonce: u64
)]
pub struct LogAccessEvent<'info> {
    /// Accessor pays rent — no admin co-signature required.
    #[account(mut)]
    pub accessor: Signer<'info>,
    #[account(
        seeds = [USER_IDENTITY_SEED, user_identity.app_user_id_hash.as_ref()],
        bump = user_identity.bump
    )]
    pub user_identity: Account<'info, UserIdentity>,
    #[account(
        seeds = [PATIENT_SEED, patient_id_hash.as_ref()],
        bump = patient.bump
    )]
    pub patient: Account<'info, PatientProfile>,
    /// CHECK: Resource pubkey is stored for audit reference only.
    pub resource: UncheckedAccount<'info>,
    #[account(
        init,
        payer = accessor,
        space = AccessEvent::SPACE,
        seeds = [
            ACCESS_EVENT_SEED,
            patient.key().as_ref(),
            accessor.key().as_ref(),
            resource_hash.as_ref(),
            &nonce.to_le_bytes(),
        ],
        bump
    )]
    pub access_event: Account<'info, AccessEvent>,
    pub system_program: Program<'info, System>,
}
