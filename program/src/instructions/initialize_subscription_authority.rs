use pinocchio::{
    cpi::Seed,
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    AccountView, ProgramResult,
};

use pinocchio_token::instructions::Approve as ApproveSpl;
use pinocchio_token_2022::instructions::Approve as Approve2022;

use crate::{
    check_token_account_mint, check_token_account_owner, constants::TOKEN_2022_PROGRAM_ID,
    AccountCheck, AssociatedTokenAccount, AssociatedTokenAccountCheck, MintInterface,
    ProgramAccount, ProgramAccountInit, SignerAccount, SubscriptionAuthority, SubscriptionsError,
    SystemAccount, TokenAccountInterface, TokenProgramInterface, WritableAccount,
};

/// Validated accounts for the [`InitSubscriptionAuthority`](crate::SubscriptionsInstruction::InitSubscriptionAuthority) instruction.
pub struct InitializeSubscriptionAuthorityAccounts<'a> {
    pub user: &'a AccountView,
    pub subscription_authority: &'a AccountView,
    pub token_mint: &'a AccountView,
    pub user_ata: &'a AccountView,
    pub system_program: &'a AccountView,
    pub token_program: &'a AccountView,
    /// The account funding rent. Defaults to `user` if no extra account is provided.
    pub payer: &'a AccountView,
}

impl<'a> TryFrom<&'a [AccountView]> for InitializeSubscriptionAuthorityAccounts<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a [AccountView]) -> Result<Self, Self::Error> {
        let [user, subscription_authority, token_mint, user_ata, system_program, token_program, rem @ ..] =
            accounts
        else {
            return Err(SubscriptionsError::NotEnoughAccountKeys.into());
        };

        SignerAccount::check(user)?;
        WritableAccount::check(user)?;
        WritableAccount::check(subscription_authority)?;
        WritableAccount::check(user_ata)?;
        MintInterface::check_with_program(token_mint, token_program)?;
        TokenAccountInterface::check_with_program(user_ata, token_program)?;
        TokenProgramInterface::check(token_program)?;
        SystemAccount::check(system_program)?;

        let payer = if let Some(payer) = rem.first() {
            SignerAccount::check(payer)?;
            WritableAccount::check(payer)?;
            payer
        } else {
            user
        };

        Ok(Self {
            subscription_authority,
            user,
            token_mint,
            user_ata,
            system_program,
            token_program,
            payer,
        })
    }
}

/// Instruction discriminator byte for `InitSubscriptionAuthority`.
pub const DISCRIMINATOR: &u8 = &0;

/// Creates a [`SubscriptionAuthority`] PDA for the given user and token mint, then
/// approves this PDA as the SPL Token delegate on the user's ATA with
/// `u64::MAX` allowance.
///
/// If the PDA already exists (e.g., pre-funded by an attacker), the account
/// is reclaimed idempotently.
pub fn process(accounts: &[AccountView]) -> ProgramResult {
    let accounts = InitializeSubscriptionAuthorityAccounts::try_from(accounts)?;

    let (expected_pda, bump) =
        SubscriptionAuthority::find_pda(accounts.user.address(), accounts.token_mint.address());

    if expected_pda != *accounts.subscription_authority.address() {
        return Err(SubscriptionsError::InvalidSubscriptionAuthorityPda.into());
    }

    let bump_binding = [bump];
    let seeds = [
        Seed::from(SubscriptionAuthority::SEED),
        Seed::from(accounts.user.address().as_ref()),
        Seed::from(accounts.token_mint.address().as_ref()),
        Seed::from(&bump_binding),
    ];

    // Initialize the account if it doesn't exist.
    //
    // Idempotency note: when the PDA already exists (e.g., re-running init
    // to refresh the SPL `Approve` after the user revoked it), the trailing
    // optional `payer` account is intentionally NOT used to overwrite the
    // stored payer. The original sponsor recorded at first creation remains
    // the rent recipient on close.
    if accounts.subscription_authority.data_len() == 0 {
        ProgramAccount::init::<SubscriptionAuthority>(
            accounts.payer,
            accounts.subscription_authority,
            &seeds,
            SubscriptionAuthority::LEN,
        )?;

        let init_id = Clock::get()?.slot as i64;
        let mut data = accounts.subscription_authority.try_borrow_mut()?;
        SubscriptionAuthority::init(
            &mut data,
            accounts.user.address(),
            accounts.token_mint.address(),
            accounts.payer.address(),
            bump,
            init_id,
        )?;
    }

    {
        let ata_data = accounts.user_ata.try_borrow()?;
        check_token_account_owner(&ata_data, accounts.user.address())?;
        check_token_account_mint(&ata_data, accounts.token_mint.address())?;
    }
    AssociatedTokenAccount::check(
        accounts.user_ata,
        accounts.user,
        accounts.token_mint,
        accounts.token_program,
    )?;

    // Approve delegation on the correct token program (SPL Token vs Token-2022).
    // The instruction data is the same, but the program id differs.
    //
    // Authority must be `accounts.user` (the ATA owner). A sponsor cannot
    // approve on the user's ATA — sponsor only funds rent. The user must
    // still sign this instruction so the Approve CPI succeeds.
    if accounts.token_program.address().eq(&TOKEN_2022_PROGRAM_ID) {
        Approve2022 {
            token_program: accounts.token_program.address(),
            source: accounts.user_ata,
            delegate: accounts.subscription_authority,
            authority: accounts.user,
            amount: u64::MAX,
        }
        .invoke()?;
    } else {
        ApproveSpl {
            source: accounts.user_ata,
            delegate: accounts.subscription_authority,
            authority: accounts.user,
            amount: u64::MAX,
        }
        .invoke()?;
    }

    Ok(())
}
