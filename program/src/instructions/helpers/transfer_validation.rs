use pinocchio::ProgramResult;

use crate::SubscriptionsError;

/// Returns true when a finite-expiry delegation is past its `expiry_ts`.
/// Shared lifecycle gate used by transfer paths and sponsor revocation so both
/// agree on when a finite-expiry delegation is unspendable. No drift tolerance
/// here — `expiry_ts` is a hard stop for spending and sponsor revocation; drift
/// applies only when validating timestamps at creation time.
pub fn is_expired(expiry_ts: i64, current_ts: i64) -> bool {
    expiry_ts != 0 && current_ts > expiry_ts
}

/// Validates a fixed transfer against the delegation's remaining allowance and expiry.
///
/// Returns an error if:
/// - `transfer_amount` is zero
/// - the delegation has expired (`expiry_ts != 0 && current_ts > expiry_ts`)
/// - `transfer_amount` exceeds the remaining allowance
pub fn validate_fixed_transfer(transfer_amount: u64, remaining: u64, expiry_ts: i64, current_ts: i64) -> ProgramResult {
    if transfer_amount == 0 {
        return Err(SubscriptionsError::InvalidAmount.into());
    }
    if is_expired(expiry_ts, current_ts) {
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
/// `period_length_s` and `amount_pulled_in_period` is reset to zero. For a
/// finite `expiry_ts`, advancement is capped at the last period boundary
/// strictly before expiry, so the final in-bounds period bills correctly
/// without opening a fresh allowance for a period that starts at or after
/// expiry.
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
    if is_expired(expiry_ts, current_ts) {
        return Err(SubscriptionsError::DelegationExpired.into());
    }

    let period_length = i64::try_from(period_length_s).map_err(|_| SubscriptionsError::InvalidPeriodLength)?;
    if period_length == 0 {
        return Err(SubscriptionsError::InvalidPeriodLength.into());
    }

    if current_ts < *current_period_start_ts {
        return Err(SubscriptionsError::DelegationNotStarted.into());
    }

    let time_since_start = current_ts.saturating_sub(*current_period_start_ts);

    if time_since_start >= period_length {
        let periods_passed =
            time_since_start.checked_div(period_length).ok_or(SubscriptionsError::InvalidPeriodLength)?;
        let increment = periods_passed.checked_mul(period_length).ok_or(SubscriptionsError::ArithmeticOverflow)?;
        let candidate_start =
            current_period_start_ts.checked_add(increment).ok_or(SubscriptionsError::ArithmeticOverflow)?;
        if expiry_ts == 0 || candidate_start < expiry_ts {
            *current_period_start_ts = candidate_start;
            *amount_pulled_in_period = 0;
        } else {
            // Finite expiry and the next boundary lands at/after it: advance only to
            // the last period start strictly before expiry, so the final in-bounds
            // period bills without opening a fresh allowance for a period past expiry.
            let last_billable = expiry_ts.checked_sub(1).ok_or(SubscriptionsError::ArithmeticUnderflow)?;
            if last_billable >= *current_period_start_ts {
                let span = last_billable
                    .checked_sub(*current_period_start_ts)
                    .ok_or(SubscriptionsError::ArithmeticUnderflow)?;
                let periods_in_bounds =
                    span.checked_div(period_length).ok_or(SubscriptionsError::InvalidPeriodLength)?;
                let increment =
                    periods_in_bounds.checked_mul(period_length).ok_or(SubscriptionsError::ArithmeticOverflow)?;
                let last_in_bounds_start =
                    current_period_start_ts.checked_add(increment).ok_or(SubscriptionsError::ArithmeticOverflow)?;
                if last_in_bounds_start > *current_period_start_ts {
                    *current_period_start_ts = last_in_bounds_start;
                    *amount_pulled_in_period = 0;
                }
            }
        }
    }

    let available =
        amount_per_period.checked_sub(*amount_pulled_in_period).ok_or(SubscriptionsError::ArithmeticUnderflow)?;
    if transfer_amount > available {
        return Err(SubscriptionsError::AmountExceedsPeriodLimit.into());
    }

    *amount_pulled_in_period =
        amount_pulled_in_period.checked_add(transfer_amount).ok_or(SubscriptionsError::ArithmeticOverflow)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(start: i64, pulled: u64, expiry: i64, now: i64) -> (ProgramResult, i64, u64) {
        let mut period_start = start;
        let mut amount_pulled = pulled;
        let res = validate_recurring_transfer(100, 100, 30, &mut period_start, &mut amount_pulled, expiry, now);
        (res, period_start, amount_pulled)
    }

    #[test]
    fn catch_up_at_exact_expiry_boundary_succeeds() {
        let (res, start, pulled) = run(0, 100, 90, 90);
        assert!(res.is_ok());
        assert_eq!(start, 60);
        assert_eq!(pulled, 100);
    }

    #[test]
    fn boundary_before_expiry_advances_normally() {
        let (res, start, pulled) = run(0, 100, 90, 35);
        assert!(res.is_ok());
        assert_eq!(start, 30);
        assert_eq!(pulled, 100);
    }

    #[test]
    fn fully_used_final_period_does_not_open_a_period_past_expiry() {
        let mut period_start = 60i64;
        let mut amount_pulled = 100u64;
        let res = validate_recurring_transfer(1, 100, 30, &mut period_start, &mut amount_pulled, 90, 90);
        assert!(res.is_err());
        assert_eq!(period_start, 60);
        assert_eq!(amount_pulled, 100);
    }

    #[test]
    fn recurring_transfer_past_expiry_rejected_without_drift_grace() {
        let mut period_start = 0i64;
        let mut amount_pulled = 100u64;
        let res = validate_recurring_transfer(100, 100, 100, &mut period_start, &mut amount_pulled, 300, 350);
        assert!(res.is_err());
        assert_eq!(period_start, 0);
        assert_eq!(amount_pulled, 100);
    }

    #[test]
    fn no_expiry_advances_to_floored_boundary() {
        let (res, start, pulled) = run(0, 100, 0, 90);
        assert!(res.is_ok());
        assert_eq!(start, 90);
        assert_eq!(pulled, 100);
    }

    #[test]
    fn finite_expiry_is_hard_stop_with_no_drift_grace() {
        assert!(!is_expired(100, 100));
        assert!(is_expired(100, 101));
        assert!(!is_expired(0, i64::MAX));
    }
}
