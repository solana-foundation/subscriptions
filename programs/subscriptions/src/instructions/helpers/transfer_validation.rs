use pinocchio::ProgramResult;

use crate::constants::TIME_DRIFT_ALLOWED_SECS;
use crate::SubscriptionsError;

/// Validates a fixed transfer against the delegation's remaining allowance and expiry.
///
/// Returns an error if:
/// - `transfer_amount` is zero
/// - the delegation has expired (`expiry_ts != 0 && current_ts > expiry_ts + TIME_DRIFT_ALLOWED_SECS`)
/// - `transfer_amount` exceeds the remaining allowance
pub fn validate_fixed_transfer(
    transfer_amount: u64,
    remaining: u64,
    expiry_ts: i64,
    current_ts: i64,
) -> ProgramResult {
    if transfer_amount == 0 {
        return Err(SubscriptionsError::InvalidAmount.into());
    }
    if expiry_ts != 0 && current_ts > expiry_ts.saturating_add(TIME_DRIFT_ALLOWED_SECS) {
        return Err(SubscriptionsError::DelegationExpired.into());
    }
    if transfer_amount > remaining {
        return Err(SubscriptionsError::AmountExceedsLimit.into());
    }
    Ok(())
}

/// Validates a recurring transfer against per-period limits.
///
/// Automatically advances the period when the current period has elapsed:
/// `current_period_start_ts` is moved forward by whole multiples of
/// `period_length_s` and `amount_pulled_in_period` is reset to zero.
///
/// Returns an error if:
/// - `transfer_amount` is zero
/// - the delegation has expired
/// - the delegation period has not started (`current_ts < current_period_start_ts`)
/// - `transfer_amount` exceeds the remaining per-period budget
pub fn validate_recurring_transfer(
    transfer_amount: u64,
    amount_per_period: u64,
    period_length_s: u64,
    current_period_start_ts: &mut i64,
    amount_pulled_in_period: &mut u64,
    expiry_ts: i64,
    current_ts: i64,
) -> ProgramResult {
    if transfer_amount == 0 {
        return Err(SubscriptionsError::InvalidAmount.into());
    }
    if expiry_ts != 0 && current_ts > expiry_ts.saturating_add(TIME_DRIFT_ALLOWED_SECS) {
        return Err(SubscriptionsError::DelegationExpired.into());
    }

    let period_length =
        i64::try_from(period_length_s).map_err(|_| SubscriptionsError::InvalidPeriodLength)?;
    if period_length == 0 {
        return Err(SubscriptionsError::InvalidPeriodLength.into());
    }

    if current_ts < *current_period_start_ts {
        return Err(SubscriptionsError::DelegationNotStarted.into());
    }

    let time_since_start = current_ts.saturating_sub(*current_period_start_ts);

    if time_since_start >= period_length {
        let periods_passed = time_since_start / period_length;
        let increment = periods_passed
            .checked_mul(period_length)
            .ok_or(SubscriptionsError::ArithmeticOverflow)?;
        *current_period_start_ts = current_period_start_ts
            .checked_add(increment)
            .ok_or(SubscriptionsError::ArithmeticOverflow)?;
        *amount_pulled_in_period = 0;
    }

    let available = amount_per_period
        .checked_sub(*amount_pulled_in_period)
        .ok_or(SubscriptionsError::ArithmeticUnderflow)?;
    if transfer_amount > available {
        return Err(SubscriptionsError::AmountExceedsPeriodLimit.into());
    }

    *amount_pulled_in_period = amount_pulled_in_period
        .checked_add(transfer_amount)
        .ok_or(SubscriptionsError::ArithmeticOverflow)?;

    Ok(())
}
