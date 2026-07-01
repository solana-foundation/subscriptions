use codama::CodamaErrors;
use pinocchio::error::ProgramError;
use thiserror::Error;

impl From<SubscriptionsError> for ProgramError {
    fn from(e: SubscriptionsError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

#[cfg(test)]
impl TryFrom<u32> for SubscriptionsError {
    type Error = u32;

    fn try_from(code: u32) -> Result<Self, Self::Error> {
        match code {
            // Generic errors (100-199)
            100 => Ok(Self::NotSigner),
            101 => Ok(Self::InvalidAddress),
            102 => Ok(Self::InvalidEscrowPda),
            103 => Ok(Self::InvalidSubscriptionAuthorityPda),
            104 => Ok(Self::NotSystemProgram),
            105 => Ok(Self::InvalidTokenProgram),
            106 => Ok(Self::InvalidToken2022MintAccountData),
            107 => Ok(Self::InvalidToken2022TokenAccountData),
            108 => Ok(Self::InvalidAssociatedTokenAccountDerivedAddress),
            109 => Ok(Self::InvalidTokenSplMintAccountData),
            110 => Ok(Self::InvalidTokenSplTokenAccountData),
            111 => Ok(Self::InvalidAccountData),
            112 => Ok(Self::InvalidInstructionData),
            113 => Ok(Self::NotEnoughAccountKeys),
            114 => Ok(Self::InvalidInstruction),
            115 => Ok(Self::ArithmeticOverflow),
            116 => Ok(Self::ArithmeticUnderflow),
            117 => Ok(Self::InvalidAccountDiscriminator),
            118 => Ok(Self::MintHasConfidentialTransfer),
            119 => Ok(Self::MintHasNonTransferable),
            120 => Ok(Self::MintHasPermanentDelegate),
            121 => Ok(Self::MintHasTransferHook),
            122 => Ok(Self::MintHasTransferFee),
            123 => Ok(Self::MintHasMintCloseAuthority),
            124 => Ok(Self::MintHasPausable),
            125 => Ok(Self::MintMismatch),
            126 => Ok(Self::InvalidDelegatePda),
            127 => Ok(Self::InvalidHeaderData),
            128 => Ok(Self::DelegationExpired),
            129 => Ok(Self::InvalidAmount),
            130 => Ok(Self::Unauthorized),
            131 => Ok(Self::AccountNotWritable),
            132 => Ok(Self::AtaOwnerMismatch),
            133 => Ok(Self::DelegationVersionMismatch),
            134 => Ok(Self::MigrationRequired),
            135 => Ok(Self::DelegationAlreadyExists),
            136 => Ok(Self::StaleSubscriptionAuthority),
            137 => Ok(Self::TransferHookTooManyAccounts),
            // Fixed delegation errors (300-399)
            300 => Ok(Self::AmountExceedsLimit),
            301 => Ok(Self::FixedDelegationExpiryInPast),
            302 => Ok(Self::FixedDelegationAmountZero),
            // Recurring delegation errors (400-499)
            400 => Ok(Self::AmountExceedsPeriodLimit),
            401 => Ok(Self::PeriodNotElapsed),
            402 => Ok(Self::InvalidPeriodLength),
            403 => Ok(Self::InvalidPayerData),
            404 => Ok(Self::RecurringDelegationStartTimeInPast),
            405 => Ok(Self::RecurringDelegationStartTimeGreaterThanExpiry),
            406 => Ok(Self::RecurringDelegationAmountZero),
            407 => Ok(Self::DelegationNotStarted),
            408 => Ok(Self::RecurringDelegationStartOnLandingRequiresExpiry),
            // Plan and subscription errors (500-599)
            500 => Ok(Self::PlanSunset),
            501 => Ok(Self::PlanExpired),
            502 => Ok(Self::InvalidPlanPda),
            503 => Ok(Self::InvalidSubscriptionPda),
            504 => Ok(Self::NotPlanOwner),
            505 => Ok(Self::SubscriptionPlanMismatch),
            506 => Ok(Self::UnauthorizedDestination),
            507 => Ok(Self::InvalidNumDestinations),
            508 => Ok(Self::SubscriptionCancelled),
            509 => Ok(Self::SubscriptionAlreadyCancelled),
            510 => Ok(Self::SubscriptionNotCancelled),
            511 => Ok(Self::InvalidEndTs),
            512 => Ok(Self::InvalidPlanStatus),
            513 => Ok(Self::PlanImmutableAfterSunset),
            514 => Ok(Self::SunsetRequiresEndTs),
            515 => Ok(Self::PlanNotExpired),
            516 => Ok(Self::PlanClosed),
            517 => Ok(Self::AlreadySubscribed),
            518 => Ok(Self::PlanAlreadyExists),
            519 => Ok(Self::PlanTermsMismatch),
            520 => Ok(Self::PlanEndTsCannotExtend),
            // Event errors (600-699)
            600 => Ok(Self::InvalidEventAuthority),
            601 => Ok(Self::InvalidEventData),
            602 => Ok(Self::InvalidEventTag),
            603 => Ok(Self::InvalidEventDiscriminator),
            604 => Ok(Self::InvalidSelfProgram),
            // Up-to delegation errors (700-799)
            700 => Ok(Self::UpToDelegationAmountZero),
            701 => Ok(Self::UpToDelegationExpiryInPast),
            702 => Ok(Self::UpToDelegationConsumed),
            703 => Ok(Self::UpToRecipientMismatch),
            _ => Err(code),
        }
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
/// - **700--799**: Up-to delegation errors.
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

    // --- Up-to delegation errors (700--799) ---
    #[error("zero max amount specified")]
    UpToDelegationAmountZero = 700,
    #[error("Expiry time specified is less than current time")]
    UpToDelegationExpiryInPast,
    #[error("Up-to delegation already consumed")]
    UpToDelegationConsumed,
    #[error("Receiver owner does not match the bound recipient")]
    UpToRecipientMismatch,
}
