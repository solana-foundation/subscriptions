//! Token-2022 transfer hook reads + forwarding CPI. `pinocchio-token-2022` has
//! no extension-state reader, so the mint TLV walk is ported manually here.

use alloc::vec::Vec;

use pinocchio::{
    cpi::{invoke_signed_with_bounds, Signer},
    error::ProgramError,
    instruction::{InstructionAccount, InstructionView},
    AccountView, Address, ProgramResult,
};

use crate::SubscriptionsError;

const ACCOUNT_TYPE_INDEX: usize = 165;
const TLV_START_INDEX: usize = ACCOUNT_TYPE_INDEX + 1;
const TLV_HEADER_LEN: usize = 4;
const EXTENSION_TYPE_TRANSFER_HOOK: u16 = 14;
const EXTRA_ACCOUNT_METAS_SEED: &[u8] = b"extra-account-metas";
const TRANSFER_HOOK_EXTENSION_LEN: usize = 64; // authority(32) || program_id(32)
const TRANSFER_HOOK_PROGRAM_ID_OFFSET: usize = 32;
const TRANSFER_CHECKED_DISCRIMINATOR: u8 = 12;

// 4 base accounts + remaining must fit the CPI stack buffer (MAX_STATIC_CPI_ACCOUNTS = 64).
pub const MAX_TRANSFER_HOOK_REMAINING_ACCOUNTS: usize = 60;
const MAX_TRANSFER_CPI_ACCOUNTS: usize = 4 + MAX_TRANSFER_HOOK_REMAINING_ACCOUNTS;

const TLV_TYPE_LEN: usize = 2;

fn find_extension_value(tlv_data: &[u8], target: u16) -> Result<Option<&[u8]>, ProgramError> {
    let mut offset = 0;

    while offset < tlv_data.len() {
        // Fewer than a type field left, or an Uninitialized (zero) type, marks
        // the end of used TLV data; trailing realloc/multisig padding lands here.
        if tlv_data.len() - offset < TLV_TYPE_LEN {
            return Ok(None);
        }
        let ext_type = u16::from_le_bytes([tlv_data[offset], tlv_data[offset + 1]]);
        if ext_type == 0 {
            return Ok(None);
        }

        if tlv_data.len() - offset < TLV_HEADER_LEN {
            return Err(SubscriptionsError::InvalidToken2022MintAccountData.into());
        }
        let length = u16::from_le_bytes([tlv_data[offset + 2], tlv_data[offset + 3]]) as usize;
        let value_start = offset + TLV_HEADER_LEN;
        let value_end = value_start.checked_add(length).ok_or(SubscriptionsError::InvalidToken2022MintAccountData)?;

        if value_end > tlv_data.len() {
            return Err(SubscriptionsError::InvalidToken2022MintAccountData.into());
        }

        if ext_type == target {
            return Ok(Some(&tlv_data[value_start..value_end]));
        }

        offset = value_end;
    }

    Ok(None)
}

/// Active transfer hook program for a mint, or `None` when absent or `program_id` is unset.
pub fn mint_transfer_hook_program_id(mint_data: &[u8]) -> Result<Option<Address>, ProgramError> {
    if mint_data.len() <= ACCOUNT_TYPE_INDEX {
        return Ok(None);
    }

    let Some(value) = find_extension_value(&mint_data[TLV_START_INDEX..], EXTENSION_TYPE_TRANSFER_HOOK)? else {
        return Ok(None);
    };

    if value.len() != TRANSFER_HOOK_EXTENSION_LEN {
        return Err(SubscriptionsError::InvalidToken2022MintAccountData.into());
    }

    let program_id = &value[TRANSFER_HOOK_PROGRAM_ID_OFFSET..];
    if program_id.iter().all(|byte| *byte == 0) {
        return Ok(None);
    }

    let mut bytes = [0u8; 32];
    bytes.copy_from_slice(program_id);
    Ok(Some(Address::new_from_array(bytes)))
}

/// `TransferChecked` CPI forwarding the caller-supplied `remaining` hook accounts
/// (each with its runtime writable/signer flags); Token-2022 validates them.
///
/// Requires the hook's `ExtraAccountMetaList` validation PDA among `remaining`.
/// Token-2022 only resolves the hook's configured policy context when that PDA
/// is passed, so without this check an active-hook transfer would fail open.
#[allow(clippy::too_many_arguments)]
pub fn invoke_transfer_checked_with_hook(
    token_program: &Address,
    hook_program: &Address,
    from: &AccountView,
    mint: &AccountView,
    to: &AccountView,
    authority: &AccountView,
    remaining: &[AccountView],
    amount: u64,
    decimals: u8,
    signers: &[Signer],
) -> ProgramResult {
    if remaining.len() > MAX_TRANSFER_HOOK_REMAINING_ACCOUNTS {
        return Err(SubscriptionsError::TransferHookTooManyAccounts.into());
    }

    let (validation_pda, _) =
        Address::find_program_address(&[EXTRA_ACCOUNT_METAS_SEED, mint.address().as_ref()], hook_program);
    if !remaining.iter().any(|account| account.address().eq(&validation_pda)) {
        return Err(SubscriptionsError::TransferHookValidationAccountMissing.into());
    }

    let mut data = [0u8; 10];
    data[0] = TRANSFER_CHECKED_DISCRIMINATOR;
    data[1..9].copy_from_slice(&amount.to_le_bytes());
    data[9] = decimals;

    let mut metas: Vec<InstructionAccount> = Vec::with_capacity(4 + remaining.len());
    metas.push(InstructionAccount::writable(from.address()));
    metas.push(InstructionAccount::readonly(mint.address()));
    metas.push(InstructionAccount::writable(to.address()));
    metas.push(InstructionAccount::readonly_signer(authority.address()));

    let mut views: Vec<&AccountView> = Vec::with_capacity(4 + remaining.len());
    views.push(from);
    views.push(mint);
    views.push(to);
    views.push(authority);

    for account in remaining {
        metas.push(InstructionAccount::new(account.address(), account.is_writable(), account.is_signer()));
        views.push(account);
    }

    let instruction = InstructionView { program_id: token_program, data: &data, accounts: &metas };

    invoke_signed_with_bounds::<MAX_TRANSFER_CPI_ACCOUNTS, _>(&instruction, &views, signers)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tlv_entry(ext_type: u16, value: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&ext_type.to_le_bytes());
        out.extend_from_slice(&(value.len() as u16).to_le_bytes());
        out.extend_from_slice(value);
        out
    }

    fn mint_with_tlv(tlv: &[u8]) -> Vec<u8> {
        let mut data = alloc::vec![0u8; TLV_START_INDEX];
        data.extend_from_slice(tlv);
        data
    }

    fn hook_value(authority: [u8; 32], program_id: [u8; 32]) -> Vec<u8> {
        let mut value = Vec::with_capacity(TRANSFER_HOOK_EXTENSION_LEN);
        value.extend_from_slice(&authority);
        value.extend_from_slice(&program_id);
        value
    }

    #[test]
    fn base_only_mint_has_no_hook() {
        let data = alloc::vec![0u8; 82];
        assert_eq!(mint_transfer_hook_program_id(&data).unwrap(), None);
    }

    #[test]
    fn no_transfer_hook_extension_returns_none() {
        let tlv = tlv_entry(1, &[0u8; 8]);
        let data = mint_with_tlv(&tlv);
        assert_eq!(mint_transfer_hook_program_id(&data).unwrap(), None);
    }

    #[test]
    fn inert_hook_with_zero_program_id_returns_none() {
        let tlv = tlv_entry(EXTENSION_TYPE_TRANSFER_HOOK, &hook_value([7u8; 32], [0u8; 32]));
        let data = mint_with_tlv(&tlv);
        assert_eq!(mint_transfer_hook_program_id(&data).unwrap(), None);
    }

    #[test]
    fn active_hook_returns_program_id() {
        let program_id = [9u8; 32];
        let tlv = tlv_entry(EXTENSION_TYPE_TRANSFER_HOOK, &hook_value([7u8; 32], program_id));
        let data = mint_with_tlv(&tlv);
        assert_eq!(mint_transfer_hook_program_id(&data).unwrap(), Some(Address::new_from_array(program_id)));
    }

    #[test]
    fn finds_hook_after_other_extension() {
        let mut tlv = tlv_entry(1, &[0u8; 8]);
        tlv.extend_from_slice(&tlv_entry(EXTENSION_TYPE_TRANSFER_HOOK, &hook_value([1u8; 32], [3u8; 32])));
        let data = mint_with_tlv(&tlv);
        assert_eq!(mint_transfer_hook_program_id(&data).unwrap(), Some(Address::new_from_array([3u8; 32])));
    }

    #[test]
    fn entry_length_past_buffer_is_rejected() {
        let mut tlv = Vec::new();
        tlv.extend_from_slice(&EXTENSION_TYPE_TRANSFER_HOOK.to_le_bytes());
        tlv.extend_from_slice(&64u16.to_le_bytes());
        tlv.extend_from_slice(&[0u8; 8]);
        let data = mint_with_tlv(&tlv);
        assert!(mint_transfer_hook_program_id(&data).is_err());
    }

    #[test]
    fn trailing_partial_header_is_rejected() {
        let mut tlv = tlv_entry(1, &[0u8; 4]);
        tlv.extend_from_slice(&[0xAB, 0xCD]);
        let data = mint_with_tlv(&tlv);
        assert!(mint_transfer_hook_program_id(&data).is_err());
    }

    #[test]
    fn wrong_length_hook_value_is_rejected() {
        let tlv = tlv_entry(EXTENSION_TYPE_TRANSFER_HOOK, &[5u8; 32]);
        let data = mint_with_tlv(&tlv);
        assert!(mint_transfer_hook_program_id(&data).is_err());
    }

    #[test]
    fn trailing_zero_padding_is_accepted() {
        let mut tlv = tlv_entry(1, &[0u8; 4]);
        tlv.extend_from_slice(&[0u8, 0u8]);
        let data = mint_with_tlv(&tlv);
        assert_eq!(mint_transfer_hook_program_id(&data).unwrap(), None);
    }

    #[test]
    fn single_trailing_byte_is_ignored() {
        let mut tlv = tlv_entry(1, &[0u8; 4]);
        tlv.push(0xAB);
        let data = mint_with_tlv(&tlv);
        assert_eq!(mint_transfer_hook_program_id(&data).unwrap(), None);
    }

    #[test]
    fn finds_hook_before_trailing_padding() {
        let mut tlv = tlv_entry(EXTENSION_TYPE_TRANSFER_HOOK, &hook_value([1u8; 32], [3u8; 32]));
        tlv.extend_from_slice(&[0u8, 0u8]);
        let data = mint_with_tlv(&tlv);
        assert_eq!(mint_transfer_hook_program_id(&data).unwrap(), Some(Address::new_from_array([3u8; 32])));
    }
}
