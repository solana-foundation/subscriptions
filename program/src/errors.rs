use codama::CodamaErrors;
use pinocchio::error::ProgramError;
use thiserror::Error;

impl From<SubscriptionsError> for ProgramError {
    fn from(e: SubscriptionsError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

/// Program-specific error codes for the subscriptions program.
///
/// Error codes are grouped by category:
/// - **100--199**: Generic account and data validation errors.
/// - **300--399**: Fixed delegation errors.
/// - **400--499**: Recurring delegation errors.
/// - **500--599**: Plan and subscription errors.
/// - **600--699**: Event emission errors.
#[derive(Debug, Copy, Clone, Error, CodamaErrors)]
pub enum SubscriptionsError {
    // --- Generic errors (100--199) ---
    #[error("Account must be a signer")]
    NotSigner = 100,
    #[error("Invalid account address")]
    InvalidAddress,
    #[error("Invalid escrow PDA derivation")]
    InvalidEscrowPda,
    #[error("Invalid subscription-authority PDA derivation")]
    InvalidSubscriptionAuthorityPda,
    #[error("Expected system program")]
    NotSystemProgram,
    #[error("Token Program does not match other accounts")]
    InvalidTokenProgram,
    #[error("Invalid Token-2022 mint account data")]
    InvalidToken2022MintAccountData,
    #[error("Invalid Token-2022 token account data")]
    InvalidToken2022TokenAccountData,
    #[error("Invalid associated token account address")]
    InvalidAssociatedTokenAccountDerivedAddress,
    #[error("Invalid SPL Token mint account data")]
    InvalidTokenSplMintAccountData,
    #[error("Invalid SPL Token account data")]
    InvalidTokenSplTokenAccountData,
    #[error("Invalid account data")]
    InvalidAccountData,
    #[error("Invalid instruction data")]
    InvalidInstructionData,
    #[error("Not enough account keys provided")]
    NotEnoughAccountKeys,
    #[error("Invalid instruction")]
    InvalidInstruction,
    #[error("Arithmetic Overflow")]
    ArithmeticOverflow,
    #[error("Arithmetic Underflow")]
    ArithmeticUnderflow,
    #[error("Invalid account discriminator")]
    InvalidAccountDiscriminator,
    // The Token-2022 extension guards below (codes 118--124) are no longer enforced;
    // the program does not reject mints by extension. Each is retained only for
    // backward compatibility so existing clients keep decoding these error codes.
    /// Unused; retained for backward compatibility.
    #[error("Mint has ConfidentialTransfer extension")]
    MintHasConfidentialTransfer,
    /// Unused; retained for backward compatibility.
    #[error("Mint has NonTransferable extension")]
    MintHasNonTransferable,
    /// Unused; retained for backward compatibility.
    #[error("Mint has PermanentDelegate extension")]
    MintHasPermanentDelegate,
    /// Unused; retained for backward compatibility.
    #[error("Mint has TransferHook extension")]
    MintHasTransferHook,
    /// Unused; retained for backward compatibility.
    #[error("Mint has TransferFee extension")]
    MintHasTransferFee,
    /// Unused; retained for backward compatibility.
    #[error("Mint has MintCloseAuthority extension")]
    MintHasMintCloseAuthority,
    /// Unused; retained for backward compatibility.
    #[error("Mint has Pausable extension")]
    MintHasPausable,
    #[error("Token mint mismatch")]
    MintMismatch,
    #[error("Invalid delegation PDA derivation")]
    InvalidDelegatePda,
    #[error("Invalid header data")]
    InvalidHeaderData,
    #[error("Delegation has expired")]
    DelegationExpired,
    #[error("Invalid amount specified")]
    InvalidAmount,
    #[error("Caller not authorized for this action")]
    Unauthorized,
    #[error("Account must be writable")]
    AccountNotWritable,
    #[error("Token account owner does not match expected")]
    AtaOwnerMismatch,
    #[error("Delegation header version is not compatible")]
    DelegationVersionMismatch,
    #[error("Account requires explicit migration")]
    MigrationRequired,
    #[error("Delegation account already exists")]
    DelegationAlreadyExists,
    #[error("Delegation init_id does not match current SubscriptionAuthority")]
    StaleSubscriptionAuthority,
    /// Reserved for backwards compatibility.
    #[error("Too many transfer hook accounts provided")]
    TransferHookTooManyAccounts,
    #[error("Account holds no lamports above the rent-exempt minimum")]
    NoExcessLamports,

    // --- Fixed delegation errors (300--399) ---
    #[error("Transfer amount exceeds delegation limit")]
    AmountExceedsLimit = 300,
    #[error("Expiry time specified is less than current time")]
    FixedDelegationExpiryInPast,
    #[error("zero amount specified")]
    FixedDelegationAmountZero,

    // --- Recurring delegation errors (400--499) ---
    #[error("Transfer amount exceeds period limit")]
    AmountExceedsPeriodLimit = 400,
    #[error("Period has not elapsed yet")]
    PeriodNotElapsed,
    #[error("Invalid Period length")]
    InvalidPeriodLength,
    #[error("Payer provided does not match delegation")]
    InvalidPayerData,
    #[error("Past start time specified")]
    RecurringDelegationStartTimeInPast,
    #[error("start time specified is greater than expiry")]
    RecurringDelegationStartTimeGreaterThanExpiry,
    #[error("zero amount specified")]
    RecurringDelegationAmountZero,
    #[error("Delegation period has not started yet")]
    DelegationNotStarted,
    #[error("start_ts of 0 (start on landing) requires a non-zero expiry")]
    RecurringDelegationStartOnLandingRequiresExpiry,

    // --- Plan and subscription errors (500--599) ---
    #[error("Plan is in sunset status")]
    PlanSunset = 500,
    #[error("Plan has expired")]
    PlanExpired,
    #[error("Invalid Plan PDA derivation")]
    InvalidPlanPda,
    #[error("Invalid subscription PDA derivation")]
    InvalidSubscriptionPda,
    #[error("Caller is not the plan owner")]
    NotPlanOwner,
    #[error("Subscription does not belong to this plan")]
    SubscriptionPlanMismatch,
    #[error("Destination not in plan whitelist")]
    UnauthorizedDestination,
    #[error("No valid destinations provided")]
    InvalidNumDestinations,
    #[error("Subscription cancelled and past valid period")]
    SubscriptionCancelled,
    #[error("Subscription already cancelled")]
    SubscriptionAlreadyCancelled,
    #[error("Subscription is not cancelled")]
    SubscriptionNotCancelled,
    #[error("End timestamp must be zero or in the future")]
    InvalidEndTs,
    #[error("Invalid plan status value")]
    InvalidPlanStatus,
    #[error("Plan cannot be updated after sunset")]
    PlanImmutableAfterSunset,
    #[error("Sunset requires a non-zero end timestamp")]
    SunsetRequiresEndTs,
    #[error("Plan must be expired to delete")]
    PlanNotExpired,
    #[error("Plan account has been closed")]
    PlanClosed,
    #[error("Already subscribed to this plan")]
    AlreadySubscribed,
    #[error("Plan account already exists")]
    PlanAlreadyExists,
    #[error("Subscription plan terms do not match the current plan")]
    PlanTermsMismatch,
    #[error("A finite plan end timestamp can only be shortened, not removed or extended")]
    PlanEndTsCannotExtend,
    #[error("Subscription approval does not match the current subscription")]
    StaleSubscriptionApproval,
    #[error("Plan update approval does not match the current plan state")]
    StalePlanApproval,

    // --- Event errors (600--699) ---
    #[error("Invalid event authority PDA")]
    InvalidEventAuthority = 600,
    #[error("Invalid event data")]
    InvalidEventData,
    #[error("Invalid event tag prefix")]
    InvalidEventTag,
    #[error("Unknown event discriminator")]
    InvalidEventDiscriminator,
    #[error("Self program account does not match this program")]
    InvalidSelfProgram,
}
