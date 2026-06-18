/// The Token-2022 program address, re-exported from `pinocchio_token_2022`.
pub const TOKEN_2022_PROGRAM_ID: pinocchio::Address = pinocchio_token_2022::ID;

/// Maximum allowed clock drift (in seconds) when validating timestamps.
///
/// Delegation creation timestamps are compared against `Clock::unix_timestamp`.
/// This tolerance accounts for slot-level clock skew.
pub const TIME_DRIFT_ALLOWED_SECS: i64 = 120; // seconds

/// Byte offset of the account-type discriminator within Token-2022 account data.
///
/// For Token-2022 accounts larger than the base SPL Token layout, byte 165
/// contains `0x01` for mints and `0x02` for token accounts.
pub const TOKEN_2022_ACCOUNT_DISCRIMINATOR_OFFSET: usize = 165;

/// Token-2022 discriminator value indicating a **mint** account.
pub const TOKEN_2022_MINT_DISCRIMINATOR: u8 = 0x01;

/// Token-2022 discriminator value indicating a **token account**.
pub const TOKEN_2022_TOKEN_ACCOUNT_DISCRIMINATOR: u8 = 0x02;

/// Byte offset where the `mint` pubkey begins in an SPL token account's data.
pub const TOKEN_ACCOUNT_MINT_OFFSET: usize = 0;

/// Byte offset one past the end of the `mint` pubkey (i.e., `MINT_OFFSET + 32`).
pub const TOKEN_ACCOUNT_MINT_END: usize = TOKEN_ACCOUNT_MINT_OFFSET + 32;

/// Byte offset where the `owner` pubkey begins in an SPL token account's data.
pub const TOKEN_ACCOUNT_OWNER_OFFSET: usize = 32;

/// Byte offset one past the end of the `owner` pubkey (i.e., `OWNER_OFFSET + 32`).
pub const TOKEN_ACCOUNT_OWNER_END: usize = TOKEN_ACCOUNT_OWNER_OFFSET + 32;

/// Byte offset of the `delegate` `COption` tag in an SPL token account's data.
/// `0` means no delegate; `1` means the 32-byte pubkey at [`TOKEN_ACCOUNT_DELEGATE_OFFSET`] is set.
pub const TOKEN_ACCOUNT_DELEGATE_TAG_OFFSET: usize = 72;

/// Byte offset where the `delegate` pubkey begins (immediately after its 4-byte `COption` tag).
pub const TOKEN_ACCOUNT_DELEGATE_OFFSET: usize = TOKEN_ACCOUNT_DELEGATE_TAG_OFFSET + 4;

/// Byte offset one past the end of the `delegate` pubkey (i.e., `DELEGATE_OFFSET + 32`).
pub const TOKEN_ACCOUNT_DELEGATE_END: usize = TOKEN_ACCOUNT_DELEGATE_OFFSET + 32;

/// Byte offset of the `is_initialized` flag in an SPL Token / Token-2022 base mint.
/// `1` means initialized; the base mint layout is shared by both programs.
pub const MINT_IS_INITIALIZED_OFFSET: usize = 45;

/// Number of seconds in one hour. Used to convert plan/subscription period (hours) to seconds.
pub const SECS_PER_HOUR: u64 = 3600;
