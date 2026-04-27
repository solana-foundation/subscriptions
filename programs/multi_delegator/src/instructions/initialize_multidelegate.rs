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
    AccountCheck, MintInterface, MultiDelegate, MultiDelegatorError, ProgramAccount,
    ProgramAccountInit, SignerAccount, SystemAccount, TokenAccountInterface, TokenProgramInterface,
    WritableAccount,
};

/// Validated accounts for the [`InitMultiDelegate`](crate::MultiDelegatorInstruction::InitMultiDelegate) instruction.
pub struct InitializeMultiDelegateAccounts<'a> {
    pub user: &'a AccountView,
    pub multi_delegate: &'a AccountView,
    pub token_mint: &'a AccountView,
    pub user_ata: &'a AccountView,
    pub system_program: &'a AccountView,
    pub token_program: &'a AccountView,
    /// The account funding rent. Defaults to `user` if no extra account is provided.
    pub payer: &'a AccountView,
}

impl<'a> TryFrom<&'a [AccountView]> for InitializeMultiDelegateAccounts<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a [AccountView]) -> Result<Self, Self::Error> {
        let [user, multi_delegate, token_mint, user_ata, system_program, token_program, rem @ ..] =
            accounts
        else {
            return Err(MultiDelegatorError::NotEnoughAccountKeys.into());
        };

        SignerAccount::check(user)?;
        WritableAccount::check(user)?;
        WritableAccount::check(multi_delegate)?;
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
            multi_delegate,
            user,
            token_mint,
            user_ata,
            system_program,
            token_program,
            payer,
        })
    }
}

/// Instruction discriminator byte for `InitMultiDelegate`.
pub const DISCRIMINATOR: &u8 = &0;

/// Creates a [`MultiDelegate`] PDA for the given user and token mint, then
/// approves this PDA as the SPL Token delegate on the user's ATA with
/// `u64::MAX` allowance.
///
/// If the PDA already exists (e.g., pre-funded by an attacker), the account
/// is reclaimed idempotently.
pub fn process(accounts: &[AccountView]) -> ProgramResult {
    let accounts = InitializeMultiDelegateAccounts::try_from(accounts)?;

    let (expected_pda, bump) =
        MultiDelegate::find_pda(accounts.user.address(), accounts.token_mint.address());

    if expected_pda != *accounts.multi_delegate.address() {
        return Err(MultiDelegatorError::InvalidMultiDelegatePda.into());
    }

    let bump_binding = [bump];
    let seeds = [
        Seed::from(MultiDelegate::SEED),
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
    if accounts.multi_delegate.data_len() == 0 {
        ProgramAccount::init::<MultiDelegate>(
            accounts.payer,
            accounts.multi_delegate,
            &seeds,
            MultiDelegate::LEN,
        )?;

        let init_id = Clock::get()?.slot as i64;
        let mut data = accounts.multi_delegate.try_borrow_mut()?;
        MultiDelegate::init(
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
            delegate: accounts.multi_delegate,
            authority: accounts.user,
            amount: u64::MAX,
        }
        .invoke()?;
    } else {
        ApproveSpl {
            source: accounts.user_ata,
            delegate: accounts.multi_delegate,
            authority: accounts.user,
            amount: u64::MAX,
        }
        .invoke()?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use solana_signer::Signer;
    use spl_token_2022::extension::ExtensionType;

    use crate::{
        tests::{
            asserts::TransactionResultExt,
            constants::{
                MINT_DECIMALS, SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
            },
            utils::{
                fetch_account, init_ata, init_mint, init_wallet, initialize_multidelegate_action,
                initialize_multidelegate_action_with_sponsor, setup,
            },
        },
        AccountDiscriminator, MultiDelegate, MultiDelegatorError,
    };

    #[test]
    fn initialize_multidelegate() {
        let (litesvm, user) = &mut setup();

        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            Some(user.pubkey()),
            &[],
        );
        let user_ata = init_ata(litesvm, mint, user.pubkey(), 1_000_000);

        let (res, multi_delegate_pda, bump) = initialize_multidelegate_action(litesvm, user, mint);
        res.assert_ok();

        let account = litesvm.get_account(&multi_delegate_pda).unwrap();
        let multi_delegate = MultiDelegate::load(&account.data).unwrap();

        assert_eq!(
            multi_delegate.discriminator,
            AccountDiscriminator::MultiDelegate as u8
        );
        assert_eq!(multi_delegate.user.to_bytes(), user.pubkey().to_bytes());
        assert_eq!(multi_delegate.token_mint.to_bytes(), mint.to_bytes());
        // Default payer is the user when no sponsor is supplied.
        assert_eq!(multi_delegate.payer.to_bytes(), user.pubkey().to_bytes());
        assert_eq!(multi_delegate.bump, bump);
        assert!(multi_delegate.init_id >= 0);

        // Verify delegation
        let ata_account = fetch_account::<spl_token_2022::state::Account>(litesvm, &user_ata);
        assert!(ata_account.delegate.is_some());
        assert_eq!(ata_account.delegate.unwrap(), multi_delegate_pda);
        assert_eq!(ata_account.delegated_amount, u64::MAX);
    }

    #[test]
    fn initialize_multidelegate_with_sponsor() {
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
        let user_ata = init_ata(litesvm, mint, user.pubkey(), 1_000_000);

        let user_balance_before = litesvm.get_account(&user.pubkey()).unwrap().lamports;
        let sponsor_balance_before = litesvm.get_account(&sponsor.pubkey()).unwrap().lamports;

        let (res, multi_delegate_pda, _bump) =
            initialize_multidelegate_action_with_sponsor(litesvm, user, mint, Some(&sponsor));
        res.assert_ok();

        let account = litesvm.get_account(&multi_delegate_pda).unwrap();
        let md = MultiDelegate::load(&account.data).unwrap();
        assert_eq!(md.user.to_bytes(), user.pubkey().to_bytes());
        assert_eq!(md.payer.to_bytes(), sponsor.pubkey().to_bytes());

        // Sponsor pays both rent and the transaction fee. User must not be charged.
        let user_balance_after = litesvm.get_account(&user.pubkey()).unwrap().lamports;
        let sponsor_balance_after = litesvm.get_account(&sponsor.pubkey()).unwrap().lamports;
        assert_eq!(user_balance_after, user_balance_before);
        assert!(sponsor_balance_after < sponsor_balance_before);

        // Verify Approve still went through with user as the ATA authority.
        let ata_account = fetch_account::<spl_token_2022::state::Account>(litesvm, &user_ata);
        assert_eq!(ata_account.delegate.unwrap(), multi_delegate_pda);
        assert_eq!(ata_account.delegated_amount, u64::MAX);
    }

    #[rstest]
    #[case::no_extensions(&[], None)]
    #[case::confidential_transfer(
        &[ExtensionType::ConfidentialTransferMint],
        Some(MultiDelegatorError::MintHasConfidentialTransfer)
    )]
    #[case::non_transferable(
        &[ExtensionType::NonTransferable],
        Some(MultiDelegatorError::MintHasNonTransferable)
    )]
    #[case::permanent_delegate(
        &[ExtensionType::PermanentDelegate],
        Some(MultiDelegatorError::MintHasPermanentDelegate)
    )]
    #[case::transfer_fee(
        &[ExtensionType::TransferFeeConfig],
        Some(MultiDelegatorError::MintHasTransferFee)
    )]
    #[case::transfer_hook(
        &[ExtensionType::TransferHook],
        Some(MultiDelegatorError::MintHasTransferHook)
    )]
    #[case::pausable(
        &[ExtensionType::Pausable],
        Some(MultiDelegatorError::MintHasPausable)
    )]
    #[case::close_authority(
        &[ExtensionType::MintCloseAuthority],
        Some(MultiDelegatorError::MintHasMintCloseAuthority)
    )]
    #[case::multiple_blocked(
        &[ExtensionType::TransferFeeConfig, ExtensionType::TransferHook],
        Some(MultiDelegatorError::MintHasTransferFee)
    )]
    #[case::mixed_blocked(
        &[ExtensionType::MintCloseAuthority, ExtensionType::PermanentDelegate],
        Some(MultiDelegatorError::MintHasMintCloseAuthority)
    )]
    fn initialize_multidelegate_token_2022(
        #[case] extensions: &[ExtensionType],
        #[case] expected_error: Option<MultiDelegatorError>,
    ) {
        let (litesvm, user) = &mut setup();

        let mint = init_mint(
            litesvm,
            TOKEN_2022_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            Some(user.pubkey()),
            extensions,
        );
        let user_ata = init_ata(litesvm, mint, user.pubkey(), 1_000_000);

        let (res, multi_delegate_pda, bump) = initialize_multidelegate_action(litesvm, user, mint);

        match expected_error {
            Some(err) => res.assert_err(err),
            None => {
                res.assert_ok();

                let account = litesvm.get_account(&multi_delegate_pda).unwrap();
                let multi_delegate = MultiDelegate::load(&account.data).unwrap();

                assert_eq!(
                    multi_delegate.discriminator,
                    AccountDiscriminator::MultiDelegate as u8
                );
                assert_eq!(multi_delegate.user.to_bytes(), user.pubkey().to_bytes());
                assert_eq!(multi_delegate.token_mint.to_bytes(), mint.to_bytes());
                assert_eq!(multi_delegate.bump, bump);
                assert!(multi_delegate.init_id >= 0);

                // Verify delegation
                let ata_account =
                    fetch_account::<spl_token_2022::state::Account>(litesvm, &user_ata);
                assert!(ata_account.delegate.is_some());
                assert_eq!(ata_account.delegate.unwrap(), multi_delegate_pda);
                assert_eq!(ata_account.delegated_amount, u64::MAX);
            }
        }
    }

    #[test]
    fn wrong_token_program_returns_error() {
        use solana_instruction::{AccountMeta, Instruction};
        use solana_signer::Signer;

        use crate::{
            instructions::initialize_multidelegate,
            tests::{
                constants::PROGRAM_ID, constants::SYSTEM_PROGRAM_ID, pda::get_multidelegate_pda,
                utils::build_and_send_transaction,
            },
        };

        let (litesvm, user) = &mut setup();

        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            Some(user.pubkey()),
            &[],
        );
        let user_ata = init_ata(litesvm, mint, user.pubkey(), 1_000_000);

        let (multi_delegate_pda, _bump) = get_multidelegate_pda(&user.pubkey(), &mint);

        let fake_token_program = user.pubkey();

        let ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(user.pubkey(), true),
                AccountMeta::new(multi_delegate_pda, false),
                AccountMeta::new_readonly(mint, false),
                AccountMeta::new(user_ata, false),
                AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
                AccountMeta::new_readonly(fake_token_program, false),
            ],
            data: vec![*initialize_multidelegate::DISCRIMINATOR],
        };

        let res = build_and_send_transaction(litesvm, &[user], &user.pubkey(), &ix);
        assert!(res.is_err());
    }

    /// Verify that pre-funding a MultiDelegate PDA with lamports (DOS attack)
    /// does not prevent the legitimate user from creating the account.
    #[test]
    fn initialize_multidelegate_with_prefunded_pda() {
        use solana_account::Account;

        let (litesvm, user) = &mut setup();

        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            Some(user.pubkey()),
            &[],
        );
        let user_ata = init_ata(litesvm, mint, user.pubkey(), 1_000_000);

        // Simulate an attacker pre-funding the PDA address with lamports
        let (multi_delegate_pda, _) =
            crate::tests::pda::get_multidelegate_pda(&user.pubkey(), &mint);
        litesvm
            .set_account(
                multi_delegate_pda,
                Account {
                    lamports: 1_000,
                    data: vec![],
                    owner: solana_pubkey::Pubkey::default(), // system program
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();

        // The user should still be able to initialize the multidelegate PDA
        let (res, _, bump) = initialize_multidelegate_action(litesvm, user, mint);
        res.assert_ok();

        let account = litesvm.get_account(&multi_delegate_pda).unwrap();
        let multi_delegate = MultiDelegate::load(&account.data).unwrap();

        assert_eq!(
            multi_delegate.discriminator,
            AccountDiscriminator::MultiDelegate as u8
        );
        assert_eq!(multi_delegate.user.to_bytes(), user.pubkey().to_bytes());
        assert_eq!(multi_delegate.token_mint.to_bytes(), mint.to_bytes());
        assert_eq!(multi_delegate.bump, bump);
        assert!(multi_delegate.init_id >= 0);

        // Verify delegation
        let ata_account = fetch_account::<spl_token_2022::state::Account>(litesvm, &user_ata);
        assert!(ata_account.delegate.is_some());
        assert_eq!(ata_account.delegate.unwrap(), multi_delegate_pda);
        assert_eq!(ata_account.delegated_amount, u64::MAX);
    }

    #[test]
    fn initialize_multidelegate_with_overfunded_pda() {
        use solana_account::Account;

        let (litesvm, user) = &mut setup();

        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            Some(user.pubkey()),
            &[],
        );
        let user_ata = init_ata(litesvm, mint, user.pubkey(), 1_000_000);

        let (multi_delegate_pda, _) =
            crate::tests::pda::get_multidelegate_pda(&user.pubkey(), &mint);

        litesvm
            .set_account(
                multi_delegate_pda,
                Account {
                    lamports: 10_000_000,
                    data: vec![],
                    owner: solana_pubkey::Pubkey::default(),
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();

        let (res, _, bump) = initialize_multidelegate_action(litesvm, user, mint);
        res.assert_ok();

        let account = litesvm.get_account(&multi_delegate_pda).unwrap();
        let multi_delegate = MultiDelegate::load(&account.data).unwrap();

        assert_eq!(
            multi_delegate.discriminator,
            AccountDiscriminator::MultiDelegate as u8
        );
        assert_eq!(multi_delegate.user.to_bytes(), user.pubkey().to_bytes());
        assert_eq!(multi_delegate.token_mint.to_bytes(), mint.to_bytes());
        assert_eq!(multi_delegate.bump, bump);

        let ata_account = fetch_account::<spl_token_2022::state::Account>(litesvm, &user_ata);
        assert!(ata_account.delegate.is_some());
        assert_eq!(ata_account.delegate.unwrap(), multi_delegate_pda);
        assert_eq!(ata_account.delegated_amount, u64::MAX);
    }

    #[test]
    fn writable_accounts_must_be_writable() {
        use solana_instruction::{AccountMeta, Instruction};

        use crate::{
            instructions::initialize_multidelegate,
            tests::{
                constants::PROGRAM_ID,
                idl,
                pda::get_multidelegate_pda,
                utils::{build_and_send_transaction, init_wallet},
            },
        };

        let writable = idl::writable_account_indices("initMultiDelegate");

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
        let user_ata = init_ata(litesvm, mint, user.pubkey(), 1_000_000);
        let (multi_delegate_pda, _) = get_multidelegate_pda(&user.pubkey(), &mint);

        for (idx, _name, is_signer) in &writable {
            let mut accounts = vec![
                AccountMeta::new(user.pubkey(), true),
                AccountMeta::new(multi_delegate_pda, false),
                AccountMeta::new_readonly(mint, false),
                AccountMeta::new(user_ata, false),
                AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
                AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
            ];

            // Flip writable account to readonly, preserving signer flag
            let pubkey = accounts[*idx].pubkey;
            accounts[*idx] = AccountMeta::new_readonly(pubkey, *is_signer);

            let ix = Instruction {
                program_id: PROGRAM_ID,
                accounts,
                data: vec![*initialize_multidelegate::DISCRIMINATOR],
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
            instructions::initialize_multidelegate,
            tests::{
                constants::PROGRAM_ID,
                idl,
                pda::get_multidelegate_pda,
                utils::{build_and_send_transaction, init_wallet},
            },
        };

        let signers = idl::signer_account_indices("initMultiDelegate");

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
        let user_ata = init_ata(litesvm, mint, user.pubkey(), 1_000_000);
        let (multi_delegate_pda, _) = get_multidelegate_pda(&user.pubkey(), &mint);

        for (idx, _name, is_writable) in &signers {
            let mut accounts = vec![
                AccountMeta::new(user.pubkey(), true),
                AccountMeta::new(multi_delegate_pda, false),
                AccountMeta::new_readonly(mint, false),
                AccountMeta::new(user_ata, false),
                AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
                AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
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
                data: vec![*initialize_multidelegate::DISCRIMINATOR],
            };

            let res = build_and_send_transaction(litesvm, &[&fee_payer], &fee_payer.pubkey(), &ix);
            res.assert_err(MultiDelegatorError::NotSigner);
        }
    }

    /// A trailing account is interpreted as the optional sponsor payer.
    /// A non-signer extra must be rejected because the payer slot requires a
    /// signer.
    #[test]
    fn non_signer_payer_rejected() {
        use solana_instruction::{AccountMeta, Instruction};
        use solana_pubkey::Pubkey;
        use solana_signer::Signer;

        use crate::{
            instructions::initialize_multidelegate,
            tests::{
                constants::PROGRAM_ID, constants::TOKEN_PROGRAM_ID, pda::get_multidelegate_pda,
                utils::build_and_send_transaction,
            },
        };

        let (litesvm, user) = &mut setup();

        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            Some(user.pubkey()),
            &[],
        );
        let user_ata = init_ata(litesvm, mint, user.pubkey(), 1_000_000);

        let (multi_delegate_pda, _bump) = get_multidelegate_pda(&user.pubkey(), &mint);

        // Random pubkey that is NOT a signer in this transaction.
        let extra_account = Pubkey::new_unique();

        let ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(user.pubkey(), true),
                AccountMeta::new(multi_delegate_pda, false),
                AccountMeta::new_readonly(mint, false),
                AccountMeta::new(user_ata, false),
                AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
                AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
                AccountMeta::new_readonly(extra_account, false),
            ],
            data: vec![*initialize_multidelegate::DISCRIMINATOR],
        };

        let res = build_and_send_transaction(litesvm, &[user], &user.pubkey(), &ix);
        res.assert_err(MultiDelegatorError::NotSigner);
    }
}
