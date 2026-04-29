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
