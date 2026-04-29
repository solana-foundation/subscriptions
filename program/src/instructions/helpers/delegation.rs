use pinocchio::{cpi::Seed, error::ProgramError, AccountView, Address};

use crate::{
    state::common::find_delegation_pda, AccountCheck, AccountDiscriminator, Header, ProgramAccount, ProgramAccountInit,
    SignerAccount, SubscriptionAuthority, SubscriptionAuthorityAccount, SubscriptionsError, SystemAccount,
    WritableAccount, CURRENT_VERSION, DELEGATE_BASE_SEED,
};

/// Validated accounts shared by `CreateFixedDelegation` and `CreateRecurringDelegation`.
pub struct CreateDelegationAccounts<'a> {
    /// The token owner creating the delegation (must be signer + writable).
    pub delegator: &'a AccountView,
    /// The existing [`SubscriptionAuthority`] PDA for this user/mint pair.
    pub subscription_authority: &'a AccountView,
    /// The delegation PDA to be created (must be writable).
    pub delegation_account: &'a AccountView,
    /// The party that will receive transfer rights.
    pub delegatee: &'a AccountView,
    /// System program (for CPI account creation).
    pub system_program: &'a AccountView,
    /// The account funding rent. Defaults to `delegator` if no extra account is provided.
    pub payer: &'a AccountView,
}

impl<'a> TryFrom<&'a [AccountView]> for CreateDelegationAccounts<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a [AccountView]) -> Result<Self, Self::Error> {
        let [delegator, subscription_authority, delegation_account, delegatee, system_program, rem @ ..] = accounts
        else {
            return Err(SubscriptionsError::NotEnoughAccountKeys.into());
        };

        SignerAccount::check(delegator)?;
        WritableAccount::check(delegator)?;
        WritableAccount::check(delegation_account)?;
        SystemAccount::check(system_program)?;
        SubscriptionAuthorityAccount::check(subscription_authority)?;

        let payer = if let Some(payer) = rem.first() {
            SignerAccount::check(payer)?;
            WritableAccount::check(payer)?;
            payer
        } else {
            delegator
        };

        Ok(Self { delegator, subscription_authority, delegation_account, delegatee, system_program, payer })
    }
}

/// Creates and allocates a delegation PDA.
///
/// Verifies the delegator owns the [`SubscriptionAuthority`], derives the expected PDA,
/// and creates the account via CPI. Returns `(bump, init_id, mint)` on success.
pub fn create_delegation_account(
    accounts: &CreateDelegationAccounts,
    nonce: u64,
    space: usize,
) -> Result<(u8, i64, Address), ProgramError> {
    if accounts.delegation_account.data_len() > 0 {
        return Err(SubscriptionsError::DelegationAlreadyExists.into());
    }

    let init_id;
    let mint;
    {
        let md_data = accounts.subscription_authority.try_borrow()?;
        let subscription_authority = SubscriptionAuthority::load(&md_data)?;
        subscription_authority.check_owner(accounts.delegator.address())?;
        init_id = subscription_authority.init_id;
        mint = subscription_authority.token_mint;
    }

    let nonce_bytes = nonce.to_le_bytes();

    let (expected_pda, bump) = find_delegation_pda(
        accounts.subscription_authority.address(),
        accounts.delegator.address(),
        accounts.delegatee.address(),
        nonce,
    );

    if expected_pda != *accounts.delegation_account.address() {
        return Err(SubscriptionsError::InvalidDelegatePda.into());
    }

    let bump_bytes = [bump];
    let seeds = [
        Seed::from(DELEGATE_BASE_SEED),
        Seed::from(accounts.subscription_authority.address().as_ref()),
        Seed::from(accounts.delegator.address().as_ref()),
        Seed::from(accounts.delegatee.address().as_ref()),
        Seed::from(&nonce_bytes),
        Seed::from(&bump_bytes),
    ];

    ProgramAccount::init::<()>(accounts.payer, accounts.delegation_account, &seeds, space)?;

    Ok((bump, init_id, mint))
}

/// Populates a delegation [`Header`] with the standard fields.
pub fn init_header(
    header: &mut Header,
    discriminator: AccountDiscriminator,
    bump: u8,
    delegator: &Address,
    delegatee: &Address,
    payer: &Address,
    init_id: i64,
) {
    header.version = CURRENT_VERSION;
    header.discriminator = discriminator.into();
    header.bump = bump;
    header.delegator = *delegator;
    header.delegatee = *delegatee;
    header.payer = *payer;
    header.init_id = init_id;
}

/// Authorization checker for delegation transfers.
///
/// Verifies that the delegation belongs to the claimed delegator and that
/// the caller is the authorized delegatee. This prevents an attacker from
/// using their own delegation to transfer funds from another user's account.
pub struct Delegation;

impl Delegation {
    /// Checks that:
    /// 1. The delegation belongs to the claimed delegator
    /// 2. The caller is the authorized delegatee for this delegation
    pub fn check(
        header: &Header,
        expected_delegator: &Address,
        caller_delegatee: &Address,
    ) -> Result<(), ProgramError> {
        if header.delegator != *expected_delegator {
            return Err(SubscriptionsError::Unauthorized.into());
        }
        if header.delegatee != *caller_delegatee {
            return Err(SubscriptionsError::Unauthorized.into());
        }
        Ok(())
    }
}
