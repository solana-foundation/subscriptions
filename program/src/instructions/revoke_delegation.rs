use pinocchio::{
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    AccountView, ProgramResult,
};

use crate::{
    check_and_update_version,
    helpers::is_effectively_expired,
    state::{
        common::AccountDiscriminator, fixed_delegation::FixedDelegation, plan::Plan,
        recurring_delegation::RecurringDelegation, subscription_delegation::SubscriptionDelegation,
    },
    AccountCheck, AccountClose, Header, ProgramAccount, SignerAccount, SubscriptionsError, WritableAccount,
    DELEGATEE_OFFSET, DELEGATOR_OFFSET, DISCRIMINATOR_OFFSET, PAYER_OFFSET,
};

/// Validated accounts for the [`RevokeDelegation`](crate::SubscriptionsInstruction::RevokeDelegation) instruction.
///
/// Trailing accounts (`rem`) are parsed inside `process` based on the
/// delegation kind read from the account data, since the layout differs
/// between fixed/recurring (just an optional `receiver`) and subscription
/// (a required `plan_pda` followed by an optional `receiver`).
pub struct RevokeDelegationAccounts<'a> {
    /// The delegator or sponsor revoking the delegation (must be signer + writable).
    pub authority: &'a AccountView,
    /// The delegation PDA to close.
    pub delegation_account: &'a AccountView,
    /// Trailing accounts whose interpretation depends on delegation kind.
    pub rem: &'a [AccountView],
}

impl<'a> TryFrom<&'a [AccountView]> for RevokeDelegationAccounts<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a [AccountView]) -> Result<Self, Self::Error> {
        let [authority, delegation_account, rem @ ..] = accounts else {
            return Err(SubscriptionsError::NotEnoughAccountKeys.into());
        };

        SignerAccount::check(authority)?;
        WritableAccount::check(authority)?;
        WritableAccount::check(delegation_account)?;
        ProgramAccount::check(delegation_account)?;

        Ok(Self { authority, delegation_account, rem })
    }
}

/// Instruction discriminator byte for `RevokeDelegation`.
pub const DISCRIMINATOR: &u8 = &3;

/// Revokes a delegation by closing the delegation PDA.
/// The rent lamports are returned to the original payer.
///
/// Trailing-account layout depends on the delegation kind read from the
/// account data:
///
/// * Fixed / Recurring: `[receiver?]` — `receiver` required when the original
///   payer differs from the authority.
/// * Subscription: `[plan_pda, receiver?]` — `plan_pda` always required;
///   `receiver` required when the original payer differs from the authority.
///
/// Authorization rules:
///
/// * Fixed / Recurring: the delegator can close at any time. The sponsor
///   (original payer) can close only after the delegation's `expiry_ts` is in
///   the past (and non-zero).
/// * Subscription: the subscriber (delegator) can close once `expires_at_ts`
///   has elapsed (set by `cancel_subscription`). The sponsor can close when
///   the plan ended naturally, the plan account was deleted, or the
///   subscriber cancelled and the subscription expired.
pub fn process(accounts: &[AccountView]) -> ProgramResult {
    let accounts = RevokeDelegationAccounts::try_from(accounts)?;

    let destination = {
        let mut data = accounts.delegation_account.try_borrow_mut()?;

        if data.len() < Header::LEN {
            return Err(SubscriptionsError::InvalidHeaderData.into());
        }

        let kind = AccountDiscriminator::try_from(data[DISCRIMINATOR_OFFSET])?;

        let receiver = match kind {
            AccountDiscriminator::SubscriptionDelegation => {
                check_and_update_version(&mut data)?;
                let subscription = SubscriptionDelegation::load_with_min_size(&data)?;
                let current_ts = Clock::get()?.unix_timestamp;

                // Subscription branch consumes `[plan_pda, receiver?]`.
                let plan_pda = accounts.rem.first().ok_or(SubscriptionsError::NotEnoughAccountKeys)?;
                let receiver = accounts.rem.get(1);

                // Bind the passed plan_pda to the subscription via header.delegatee.
                if subscription.header.delegatee != *plan_pda.address() {
                    return Err(SubscriptionsError::SubscriptionPlanMismatch.into());
                }

                let is_sponsor = check_is_sponsor(&data, accounts.authority)?;

                if is_sponsor {
                    // Sponsor can revoke when subscription is cancelled+expired,
                    // when the plan account has been closed, when the plan
                    // ended naturally, or when the same plan_id was deleted and
                    // recreated with different terms — a "ghost" the
                    // subscription can no longer pull from.
                    let sub_expired = subscription.expires_at_ts != 0 && subscription.expires_at_ts <= current_ts;
                    let plan_closed = !plan_pda.owned_by(&crate::ID);
                    let plan_ended_or_recreated = if plan_closed {
                        false
                    } else {
                        let plan_data = plan_pda.try_borrow()?;
                        let plan = Plan::load(&plan_data)?;
                        let terms_mismatch = subscription.check_plan_terms(&plan.data.terms).is_err();
                        let plan_ended = plan.data.end_ts != 0 && current_ts > plan.data.end_ts;
                        terms_mismatch || plan_ended
                    };

                    if !(sub_expired || plan_closed || plan_ended_or_recreated) {
                        return Err(SubscriptionsError::Unauthorized.into());
                    }
                } else {
                    // Subscriber: must have cancelled and waited out the period.
                    if subscription.expires_at_ts == 0 || subscription.expires_at_ts > current_ts {
                        return Err(SubscriptionsError::SubscriptionNotCancelled.into());
                    }
                }

                receiver
            }
            AccountDiscriminator::FixedDelegation | AccountDiscriminator::RecurringDelegation => {
                let is_sponsor = check_is_sponsor(&data, accounts.authority)?;

                // Sponsor can only revoke expired delegations
                if is_sponsor {
                    let expiry_ts = match kind {
                        AccountDiscriminator::FixedDelegation => FixedDelegation::load_with_min_size(&data)?.expiry_ts,
                        _ => RecurringDelegation::load_with_min_size(&data)?.expiry_ts,
                    };
                    let current_ts = Clock::get()?.unix_timestamp;
                    if !is_effectively_expired(expiry_ts, current_ts) {
                        return Err(SubscriptionsError::Unauthorized.into());
                    }
                }

                accounts.rem.first()
            }
            _ => return Err(SubscriptionsError::InvalidAccountDiscriminator.into()),
        };

        resolve_destination(&data, accounts.authority, receiver)?
    };

    ProgramAccount::close(accounts.delegation_account, destination)
}

/// Checks whether the caller is the sponsor (payer) rather than the delegator.
/// Returns `Unauthorized` if the caller is neither.
fn check_is_sponsor(data: &[u8], authority: &AccountView) -> Result<bool, ProgramError> {
    let delegator_bytes: &[u8; 32] =
        data[DELEGATOR_OFFSET..DELEGATEE_OFFSET].try_into().map_err(|_| SubscriptionsError::InvalidHeaderData)?;

    if delegator_bytes == authority.address().as_ref() {
        return Ok(false);
    }

    let payer_bytes: &[u8; 32] =
        data[PAYER_OFFSET..PAYER_OFFSET + 32].try_into().map_err(|_| SubscriptionsError::InvalidPayerData)?;

    if payer_bytes == authority.address().as_ref() {
        return Ok(true);
    }

    Err(SubscriptionsError::Unauthorized.into())
}

/// Resolves the rent destination from the payer field in the header.
/// Rent always goes back to the original payer: if payer == authority, return
/// authority directly; otherwise require a receiver account matching payer.
fn resolve_destination<'a>(
    data: &[u8],
    authority: &'a AccountView,
    receiver: Option<&'a AccountView>,
) -> Result<&'a AccountView, ProgramError> {
    let payer_bytes: &[u8; 32] =
        data[PAYER_OFFSET..PAYER_OFFSET + 32].try_into().map_err(|_| SubscriptionsError::InvalidPayerData)?;

    if payer_bytes == authority.address().as_ref() {
        Ok(authority)
    } else {
        let receiver = receiver.ok_or(SubscriptionsError::NotEnoughAccountKeys)?;
        WritableAccount::check(receiver)?;
        if receiver.address().as_ref() != payer_bytes {
            return Err(SubscriptionsError::Unauthorized.into());
        }
        Ok(receiver)
    }
}
