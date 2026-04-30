//! Subscriptions Solana Program.
//!
//! A token delegation program for SPL Token and Token-2022 that allows users to
//! grant scoped spending authority to third parties without transferring ownership.
//!
//! The program supports three delegation models:
//!
//! - **Fixed delegations** -- a one-time allowance with an optional expiry timestamp.
//! - **Recurring delegations** -- a periodic allowance that resets each period, with
//!   configurable period length and overall expiry.
//! - **Subscription plans** -- merchant-defined plans where subscribers grant recurring
//!   pull access; the merchant (or whitelisted pullers) can transfer funds each period.
//!
//! All delegation state is stored in Program Derived Accounts (PDAs). The program is
//! built on the [Pinocchio](https://docs.rs/pinocchio) runtime for minimal compute
//! overhead and uses [Codama](https://github.com/codama-idl/codama) for IDL generation.

#![no_std]

extern crate alloc;

#[cfg(test)]
#[macro_use]
extern crate std;

use pinocchio::address::declare_id;

pub mod instructions;
pub use instructions::*;

pub mod state;
pub use state::*;

pub mod errors;
pub use errors::*;

pub mod event_engine;
pub mod events;

pub mod constants;
pub use constants::*;

#[cfg(not(feature = "no-entrypoint"))]
pub mod entrypoint;

#[cfg(test)]
pub mod tests;

declare_id!("De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44");

#[cfg(not(feature = "no-entrypoint"))]
use solana_security_txt::security_txt;

#[cfg(not(feature = "no-entrypoint"))]
security_txt! {
    name: "Subscriptions Program",
    project_url: "https://github.com/solana-program/subscriptions",
    contacts: "link:https://github.com/solana-program/subscriptions/security/advisories/new",
    policy: "https://github.com/solana-program/subscriptions/security/policy",
    source_code: "https://github.com/solana-program/subscriptions",
    auditors: "Cantina"
}
