pub const CONFIG_SEED: &[u8] = b"config";
pub const USER_IDENTITY_SEED: &[u8] = b"user_identity";
pub const ROLE_SEED: &[u8] = b"role";
pub const PATIENT_SEED: &[u8] = b"patient";
pub const CONSENT_SEED: &[u8] = b"consent";
pub const RECORD_SEED: &[u8] = b"record";
pub const ACCESS_EVENT_SEED: &[u8] = b"access_event";
pub const RX_SEED: &[u8] = b"rx";
pub const QR_SEED: &[u8] = b"qr";
pub const DISPENSE_SEED: &[u8] = b"dispense";
pub const INVOICE_SEED: &[u8] = b"invoice";
pub const CLAIM_SEED: &[u8] = b"claim";

pub const VIEW_RECORDS: u32 = 1 << 0;
pub const VIEW_PRESCRIPTIONS: u32 = 1 << 1;
pub const VIEW_INVOICES: u32 = 1 << 2;
pub const VIEW_ALL: u32 = VIEW_RECORDS | VIEW_PRESCRIPTIONS | VIEW_INVOICES;

pub const DEFAULT_AUTO_REIMB_THRESHOLD: u64 = 50_000;
pub const QR_TOKEN_LIFETIME_SECS: i64 = 48 * 60 * 60;
