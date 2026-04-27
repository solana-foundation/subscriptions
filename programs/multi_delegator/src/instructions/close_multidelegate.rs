use pinocchio::{error::ProgramError, AccountView, ProgramResult};

use crate::{
    AccountCheck, AccountClose, MultiDelegate, MultiDelegatorError, ProgramAccount, SignerAccount,
    WritableAccount,
};

/// Validated accounts for the [`CloseMultiDelegate`](crate::MultiDelegatorInstruction::CloseMultiDelegate) instruction.
pub struct CloseMultiDelegateAccounts<'a> {
    pub user: &'a AccountView,
    pub multi_delegate: &'a AccountView,
    /// Optional rent destination required when the recorded payer differs from
    /// the user. Must match the stored `MultiDelegate.payer`.
    pub receiver: Option<&'a AccountView>,
}

impl<'a> TryFrom<&'a [AccountView]> for CloseMultiDelegateAccounts<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a [AccountView]) -> Result<Self, Self::Error> {
        let [user, multi_delegate, rem @ ..] = accounts else {
            return Err(MultiDelegatorError::NotEnoughAccountKeys.into());
        };

        SignerAccount::check(user)?;
        WritableAccount::check(user)?;
        WritableAccount::check(multi_delegate)?;
        ProgramAccount::check(multi_delegate)?;

        Ok(Self {
            user,
            multi_delegate,
            receiver: rem.first(),
        })
    }
}

/// Instruction discriminator byte for `CloseMultiDelegate`.
pub const DISCRIMINATOR: &u8 = &6;

/// Closes a MultiDelegate PDA account, returning the lamports to the recorded
/// payer (which is the user when no sponsor funded creation, or the sponsor
/// otherwise).
///
/// Only the user who owns the MultiDelegate can close it. When the recorded
/// payer differs from the user, an optional `receiver` account must be
/// provided that matches the stored payer.
pub fn process(accounts: &[AccountView]) -> ProgramResult {
    let accounts = CloseMultiDelegateAccounts::try_from(accounts)?;

    let (stored_payer, payer_is_user) = {
        let data = accounts.multi_delegate.try_borrow()?;
        let multi_delegate = MultiDelegate::load(&data)?;

        multi_delegate.check_owner(accounts.user.address())?;

        // Verify the PDA derivation matches
        let expected_pda = MultiDelegate::verify_pda(
            &multi_delegate.user,
            &multi_delegate.token_mint,
            multi_delegate.bump,
        )?;
        if expected_pda.as_ref() != accounts.multi_delegate.address().as_ref() {
            return Err(MultiDelegatorError::InvalidMultiDelegatePda.into());
        }

        let stored_payer = multi_delegate.payer;
        let payer_is_user = stored_payer == *accounts.user.address();
        (stored_payer, payer_is_user)
    };

    if payer_is_user {
        // Self-funded — close to user (existing behavior).
        ProgramAccount::close(accounts.multi_delegate, accounts.user)
    } else {
        // Sponsor-funded — require a receiver matching the stored payer.
        let receiver = accounts
            .receiver
            .ok_or(MultiDelegatorError::NotEnoughAccountKeys)?;
        WritableAccount::check(receiver)?;
        if *receiver.address() != stored_payer {
            return Err(MultiDelegatorError::Unauthorized.into());
        }
        ProgramAccount::close(accounts.multi_delegate, receiver)
    }
}

#[cfg(test)]
mod tests {
    use solana_signer::Signer;

    use crate::{
        tests::{
            asserts::TransactionResultExt,
            constants::{MINT_DECIMALS, TOKEN_PROGRAM_ID},
            utils::{
                init_ata, init_mint, init_wallet, initialize_multidelegate_action,
                initialize_multidelegate_action_with_sponsor, setup, CloseMultiDelegate,
            },
        },
        MultiDelegate, MultiDelegatorError,
    };

    #[test]
    fn close_multidelegate() {
        let (litesvm, user) = &mut setup();

        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            Some(user.pubkey()),
            &[],
        );
        let _user_ata = init_ata(litesvm, mint, user.pubkey(), 1_000_000);

        let (res, multi_delegate_pda, _bump) = initialize_multidelegate_action(litesvm, user, mint);
        res.assert_ok();

        let account_before = litesvm.get_account(&multi_delegate_pda);
        assert!(account_before.is_some());
        let rent = account_before.unwrap().lamports;

        let user_balance_before = litesvm.get_account(&user.pubkey()).unwrap().lamports;

        let res = CloseMultiDelegate::new(litesvm, user, mint).execute();
        res.assert_ok();

        let account_after = litesvm.get_account(&multi_delegate_pda);
        assert!(
            account_after.is_none() || account_after.as_ref().map(|a| a.lamports).unwrap_or(0) == 0
        );

        let user_balance_after = litesvm.get_account(&user.pubkey()).unwrap().lamports;
        assert!(user_balance_after > user_balance_before);
        assert!(user_balance_after >= user_balance_before + rent - 10000);
    }

    #[test]
    fn non_owner_cannot_close() {
        let (litesvm, user) = &mut setup();

        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            Some(user.pubkey()),
            &[],
        );
        let _user_ata = init_ata(litesvm, mint, user.pubkey(), 1_000_000);

        let (res, multi_delegate_pda, _bump) = initialize_multidelegate_action(litesvm, user, mint);
        res.assert_ok();

        let attacker = init_wallet(litesvm, 1_000_000_000);
        let res = CloseMultiDelegate::new(litesvm, &attacker, mint)
            .pda(multi_delegate_pda)
            .execute();
        res.assert_err(MultiDelegatorError::Unauthorized);

        // Account should still exist
        let account_after = litesvm.get_account(&multi_delegate_pda);
        assert!(account_after.is_some());
        assert!(account_after.as_ref().map(|a| a.lamports).unwrap_or(0) > 0);
    }

    #[test]
    fn writable_accounts_must_be_writable() {
        use solana_instruction::{AccountMeta, Instruction};

        use crate::{
            instructions::close_multidelegate,
            tests::{
                constants::PROGRAM_ID,
                idl,
                utils::{build_and_send_transaction, init_wallet},
            },
        };

        let writable = idl::writable_account_indices("closeMultiDelegate");

        let (litesvm, user) = &mut setup();
        let fee_payer = init_wallet(litesvm, 10_000_000_000);

        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            Some(user.pubkey()),
            &[],
        );
        let _user_ata = init_ata(litesvm, mint, user.pubkey(), 1_000_000);

        let (res, multi_delegate_pda, _) = initialize_multidelegate_action(litesvm, user, mint);
        res.assert_ok();

        for (idx, _name, is_signer) in &writable {
            let mut accounts = vec![
                AccountMeta::new(user.pubkey(), true),
                AccountMeta::new(multi_delegate_pda, false),
            ];

            // Flip writable account to readonly, preserving signer flag
            let pubkey = accounts[*idx].pubkey;
            accounts[*idx] = AccountMeta::new_readonly(pubkey, *is_signer);

            let ix = Instruction {
                program_id: PROGRAM_ID,
                accounts,
                data: vec![*close_multidelegate::DISCRIMINATOR],
            };

            let res =
                build_and_send_transaction(litesvm, &[&fee_payer, user], &fee_payer.pubkey(), &ix);
            res.assert_err(MultiDelegatorError::AccountNotWritable);
        }
    }

    #[test]
    fn signer_accounts_must_be_signers() {
        use solana_instruction::{AccountMeta, Instruction};

        use crate::{
            instructions::close_multidelegate,
            tests::{
                constants::PROGRAM_ID,
                idl,
                utils::{build_and_send_transaction, init_wallet},
            },
        };

        let signers = idl::signer_account_indices("closeMultiDelegate");

        let (litesvm, user) = &mut setup();
        let fee_payer = init_wallet(litesvm, 10_000_000_000);

        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            Some(user.pubkey()),
            &[],
        );
        let _user_ata = init_ata(litesvm, mint, user.pubkey(), 1_000_000);

        let (res, multi_delegate_pda, _) = initialize_multidelegate_action(litesvm, user, mint);
        res.assert_ok();

        for (idx, _name, is_writable) in &signers {
            let mut accounts = vec![
                AccountMeta::new(user.pubkey(), true),
                AccountMeta::new(multi_delegate_pda, false),
            ];

            // Flip signer to non-signer, preserving writable flag
            let pubkey = accounts[*idx].pubkey;
            accounts[*idx] = if *is_writable {
                AccountMeta::new(pubkey, false)
            } else {
                AccountMeta::new_readonly(pubkey, false)
            };

            let ix = Instruction {
                program_id: PROGRAM_ID,
                accounts,
                data: vec![*close_multidelegate::DISCRIMINATOR],
            };

            let res = build_and_send_transaction(litesvm, &[&fee_payer], &fee_payer.pubkey(), &ix);
            res.assert_err(MultiDelegatorError::NotSigner);
        }
    }

    #[test]
    fn close_returns_rent_to_sponsor() {
        let (litesvm, user) = &mut setup();
        let sponsor = init_wallet(litesvm, 10_000_000_000);

        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            Some(user.pubkey()),
            &[],
        );
        let _user_ata = init_ata(litesvm, mint, user.pubkey(), 1_000_000);

        let (res, multi_delegate_pda, _bump) =
            initialize_multidelegate_action_with_sponsor(litesvm, user, mint, Some(&sponsor));
        res.assert_ok();

        // Stored payer should be the sponsor.
        let account = litesvm.get_account(&multi_delegate_pda).unwrap();
        let md = MultiDelegate::load(&account.data).unwrap();
        assert_eq!(md.payer.to_bytes(), sponsor.pubkey().to_bytes());

        let rent = account.lamports;
        let sponsor_balance_before = litesvm.get_account(&sponsor.pubkey()).unwrap().lamports;

        let res = CloseMultiDelegate::new(litesvm, user, mint)
            .receiver(sponsor.pubkey())
            .execute();
        res.assert_ok();

        let sponsor_balance_after = litesvm.get_account(&sponsor.pubkey()).unwrap().lamports;
        assert!(sponsor_balance_after >= sponsor_balance_before + rent - 10_000);
    }

    #[test]
    fn close_without_receiver_when_sponsor_funded_fails() {
        let (litesvm, user) = &mut setup();
        let sponsor = init_wallet(litesvm, 10_000_000_000);

        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            Some(user.pubkey()),
            &[],
        );
        let _user_ata = init_ata(litesvm, mint, user.pubkey(), 1_000_000);

        initialize_multidelegate_action_with_sponsor(litesvm, user, mint, Some(&sponsor))
            .0
            .assert_ok();

        // No receiver passed → must fail because stored payer differs from user.
        let res = CloseMultiDelegate::new(litesvm, user, mint).execute();
        res.assert_err(MultiDelegatorError::NotEnoughAccountKeys);
    }

    #[test]
    fn close_with_wrong_receiver_unauthorized() {
        let (litesvm, user) = &mut setup();
        let sponsor = init_wallet(litesvm, 10_000_000_000);
        let attacker = init_wallet(litesvm, 1_000_000_000);

        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            Some(user.pubkey()),
            &[],
        );
        let _user_ata = init_ata(litesvm, mint, user.pubkey(), 1_000_000);

        initialize_multidelegate_action_with_sponsor(litesvm, user, mint, Some(&sponsor))
            .0
            .assert_ok();

        let res = CloseMultiDelegate::new(litesvm, user, mint)
            .receiver(attacker.pubkey())
            .execute();
        res.assert_err(MultiDelegatorError::Unauthorized);
    }

    #[test]
    fn idempotent_init_preserves_original_payer() {
        let (litesvm, user) = &mut setup();
        let sponsor_a = init_wallet(litesvm, 10_000_000_000);
        let sponsor_b = init_wallet(litesvm, 10_000_000_000);

        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            Some(user.pubkey()),
            &[],
        );
        let _user_ata = init_ata(litesvm, mint, user.pubkey(), 1_000_000);

        // Sponsor A inits.
        let (res, multi_delegate_pda, _) =
            initialize_multidelegate_action_with_sponsor(litesvm, user, mint, Some(&sponsor_a));
        res.assert_ok();

        // Sponsor B re-runs init.
        initialize_multidelegate_action_with_sponsor(litesvm, user, mint, Some(&sponsor_b))
            .0
            .assert_ok();

        // Stored payer must remain sponsor A.
        let account = litesvm.get_account(&multi_delegate_pda).unwrap();
        let md = MultiDelegate::load(&account.data).unwrap();
        assert_eq!(md.payer.to_bytes(), sponsor_a.pubkey().to_bytes());
    }

    #[test]
    fn closed_account_is_zeroed() {
        let (litesvm, user) = &mut setup();

        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            Some(user.pubkey()),
            &[],
        );
        let _user_ata = init_ata(litesvm, mint, user.pubkey(), 1_000_000);

        let (res, multi_delegate_pda, _bump) = initialize_multidelegate_action(litesvm, user, mint);
        res.assert_ok();

        let res = CloseMultiDelegate::new(litesvm, user, mint).execute();
        res.assert_ok();

        let account_after = litesvm.get_account(&multi_delegate_pda);
        if let Some(account) = account_after {
            assert!(
                account.data.iter().all(|&byte| byte == 0),
                "All data should be zeroed after close"
            );
        }
    }
}
