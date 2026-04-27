use crate::{
    constants::TIME_DRIFT_ALLOWED_SECS, create_delegation_account, state::FixedDelegation,
    AccountDiscriminator, CreateDelegationAccounts, SubscriptionsError, DISCRIMINATOR_OFFSET,
};
use codama::CodamaType;
use core::mem::{size_of, transmute};
use pinocchio::sysvars::clock::Clock;
use pinocchio::sysvars::Sysvar;
use pinocchio::{error::ProgramError, AccountView, ProgramResult};

/// Instruction data payload for creating a fixed delegation.
#[repr(C, packed)]
#[derive(Debug, Clone, CodamaType)]
pub struct CreateFixedDelegationData {
    /// Client-chosen nonce that disambiguates multiple delegations between the
    /// same delegator/delegatee pair.
    pub nonce: u64,
    /// Total token amount the delegatee is authorized to transfer.
    pub amount: u64,
    /// Unix timestamp after which the delegation expires. Must be in the future
    /// (with [`TIME_DRIFT_ALLOWED_SECS`] tolerance).
    pub expiry_ts: i64,
}

impl CreateFixedDelegationData {
    /// Validates the instruction data against the current clock time.
    pub fn validate(&self, current_time: i64) -> Result<(), SubscriptionsError> {
        if self.expiry_ts != 0
            && self.expiry_ts < current_time.saturating_sub(TIME_DRIFT_ALLOWED_SECS)
        {
            return Err(SubscriptionsError::FixedDelegationExpiryInPast);
        }

        if self.amount == 0 {
            return Err(SubscriptionsError::FixedDelegationAmountZero);
        }

        Ok(())
    }
}

impl CreateFixedDelegationData {
    /// Serialized size in bytes.
    pub const LEN: usize = size_of::<CreateFixedDelegationData>();

    /// Zero-copy deserialize from raw instruction bytes.
    pub fn load(data: &[u8]) -> Result<&Self, ProgramError> {
        if data.len() != Self::LEN {
            return Err(SubscriptionsError::InvalidInstructionData.into());
        }
        Ok(unsafe { &*transmute::<*const u8, *const Self>(data.as_ptr()) })
    }
}

/// Instruction discriminator byte for `CreateFixedDelegation`.
pub const DISCRIMINATOR: &u8 = &1;

/// Creates a new [`FixedDelegation`] PDA.
///
/// Validates the instruction data, creates the delegation account via CPI,
/// and initializes its header and delegation-specific fields.
pub fn process(accounts: &[AccountView], call_data: &CreateFixedDelegationData) -> ProgramResult {
    call_data.validate(Clock::get()?.unix_timestamp)?;

    let accounts = CreateDelegationAccounts::try_from(accounts)?;

    let (bump, init_id) =
        create_delegation_account(&accounts, call_data.nonce, FixedDelegation::LEN)?;

    let binding = &mut accounts.delegation_account.try_borrow_mut()?;
    // Set discriminator before load_mut so validation passes on freshly created account
    binding[DISCRIMINATOR_OFFSET] = AccountDiscriminator::FixedDelegation as u8;
    let delegation = FixedDelegation::load_mut(binding)?;

    delegation.header.init(
        AccountDiscriminator::FixedDelegation,
        bump,
        accounts.delegator.address(),
        accounts.delegatee.address(),
        accounts.payer.address(),
        init_id,
    );
    delegation.amount = call_data.amount;
    delegation.expiry_ts = call_data.expiry_ts;

    Ok(())
}

#[cfg(test)]
mod tests {
    use solana_pubkey::Pubkey;
    use solana_signer::Signer;

    use crate::{
        tests::{
            asserts::TransactionResultExt,
            constants::{MINT_DECIMALS, TOKEN_PROGRAM_ID},
            pda::get_delegation_pda,
            utils::{
                current_ts, days, get_ata_balance, init_ata, init_mint, init_wallet,
                initialize_subscription_authority_action, move_clock_forward, setup, CreateDelegation,
                RevokeDelegation, TransferDelegation,
            },
        },
        AccountDiscriminator, FixedDelegation, SubscriptionsError,
    };

    #[test]
    fn create_fixed_delegation_with_sponsor() {
        let (litesvm, user) = &mut setup();
        let delegator = user;
        let sponsor = init_wallet(litesvm, 10_000_000_000);

        let amount: u64 = 100_000_000;
        let expiry_ts: i64 = current_ts() + days(1) as i64;
        let nonce: u64 = 0;

        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            Some(delegator.pubkey()),
            &[],
        );
        let _user_ata = init_ata(litesvm, mint, delegator.pubkey(), 1_000_000);

        initialize_subscription_authority_action(litesvm, delegator, mint)
            .0
            .assert_ok();

        let delegatee = Pubkey::new_unique();

        let delegator_balance_before = litesvm.get_account(&delegator.pubkey()).unwrap().lamports;
        let sponsor_balance_before = litesvm.get_account(&sponsor.pubkey()).unwrap().lamports;

        let (res, delegation_pda) = CreateDelegation::new(litesvm, delegator, mint, delegatee)
            .payer(&sponsor)
            .nonce(nonce)
            .fixed(amount, expiry_ts);
        res.assert_ok();

        let delegator_balance_after = litesvm.get_account(&delegator.pubkey()).unwrap().lamports;
        let sponsor_balance_after = litesvm.get_account(&sponsor.pubkey()).unwrap().lamports;

        assert_eq!(delegator_balance_after, delegator_balance_before); // Delegator shouldn't spend anything
        assert!(sponsor_balance_after < sponsor_balance_before);

        let account = litesvm.get_account(&delegation_pda).unwrap();
        let delegation_rent = account.lamports;
        let delegation = FixedDelegation::load(&account.data).unwrap();

        assert_eq!(
            delegation.header.payer.to_bytes(),
            sponsor.pubkey().to_bytes()
        );

        // Now revoke and check refund
        let res = RevokeDelegation::new(litesvm, delegator, mint, delegatee, nonce)
            .receiver(sponsor.pubkey())
            .execute();
        res.assert_ok();

        let sponsor_balance_final = litesvm.get_account(&sponsor.pubkey()).unwrap().lamports;

        assert!(sponsor_balance_final >= sponsor_balance_after + delegation_rent);

        // Check delegator paid for revoke
        let delegator_balance_final = litesvm.get_account(&delegator.pubkey()).unwrap().lamports;
        assert!(delegator_balance_final < delegator_balance_after);
    }

    #[test]
    fn create_fixed_delegation() {
        let (litesvm, user) = &mut setup();
        let payer = user;
        let amount: u64 = 100_000_000;
        let expiry_ts: i64 = current_ts() + days(1) as i64;
        let nonce: u64 = 0;

        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            Some(payer.pubkey()),
            &[],
        );
        let _user_ata = init_ata(litesvm, mint, payer.pubkey(), 1_000_000);

        initialize_subscription_authority_action(litesvm, payer, mint)
            .0
            .assert_ok();

        let delegatee = Pubkey::new_unique();

        let (res, delegation_pda) = CreateDelegation::new(litesvm, payer, mint, delegatee)
            .nonce(nonce)
            .fixed(amount, expiry_ts);
        res.assert_ok();

        let account = litesvm.get_account(&delegation_pda).unwrap();
        let delegation = FixedDelegation::load(&account.data).unwrap();

        let header = delegation.header;
        let del_amount = delegation.amount;
        let del_expiry_s = delegation.expiry_ts;
        assert_eq!(header.delegator.to_bytes(), payer.pubkey().to_bytes());
        assert_eq!(header.delegatee.to_bytes(), delegatee.to_bytes());
        assert_eq!(
            header.discriminator,
            AccountDiscriminator::FixedDelegation as u8
        );
        assert_eq!(del_amount, amount);
        assert_eq!(del_expiry_s, expiry_ts);
    }

    /// Verify that pre-funding a delegation PDA with lamports (DOS attack)
    /// does not prevent the legitimate user from creating the delegation.
    #[test]
    fn create_fixed_delegation_with_prefunded_pda() {
        use solana_account::Account;

        let (litesvm, user) = &mut setup();
        let payer = user;
        let amount: u64 = 100_000_000;
        let expiry_ts: i64 = current_ts() + days(1) as i64;
        let nonce: u64 = 0;

        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            Some(payer.pubkey()),
            &[],
        );
        let _user_ata = init_ata(litesvm, mint, payer.pubkey(), 1_000_000);

        initialize_subscription_authority_action(litesvm, payer, mint)
            .0
            .assert_ok();

        let delegatee = solana_pubkey::Pubkey::new_unique();

        // Simulate an attacker pre-funding the delegation PDA address with lamports
        let (subscription_authority_pda, _) = get_delegation_pda(
            &crate::tests::pda::get_subscription_authority_pda(&payer.pubkey(), &mint).0,
            &payer.pubkey(),
            &delegatee,
            nonce,
        );
        litesvm
            .set_account(
                subscription_authority_pda,
                Account {
                    lamports: 1_000,
                    data: vec![],
                    owner: solana_pubkey::Pubkey::default(), // system program
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();

        // The user should still be able to create the delegation PDA
        let (res, delegation_pda) = CreateDelegation::new(litesvm, payer, mint, delegatee)
            .nonce(nonce)
            .fixed(amount, expiry_ts);
        res.assert_ok();

        let account = litesvm.get_account(&delegation_pda).unwrap();
        let delegation = FixedDelegation::load(&account.data).unwrap();

        let header = delegation.header;
        let del_amount = delegation.amount;
        let del_expiry_ts = delegation.expiry_ts;
        assert_eq!(header.delegator.to_bytes(), payer.pubkey().to_bytes());
        assert_eq!(header.delegatee.to_bytes(), delegatee.to_bytes());
        assert_eq!(
            header.discriminator,
            AccountDiscriminator::FixedDelegation as u8
        );
        assert_eq!(del_amount, amount);
        assert_eq!(del_expiry_ts, expiry_ts);
    }

    // NOTE: These error tests use FixedDelegation but validate shared code paths.
    // The same checks apply to RecurringDelegation via shared helpers.

    #[test]
    fn create_delegation_without_subscription_authority() {
        let (litesvm, user) = &mut setup();
        let payer = user;

        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            Some(payer.pubkey()),
            &[],
        );
        let _user_ata = init_ata(litesvm, mint, payer.pubkey(), 1_000_000);

        let delegatee = Pubkey::new_unique();
        let (res, _) = CreateDelegation::new(litesvm, payer, mint, delegatee)
            .nonce(0)
            .fixed(100, 1000);

        assert!(res.is_err());
    }

    #[test]
    fn create_delegation_wrong_pda() {
        let (litesvm, user) = &mut setup();
        let payer = user;

        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            Some(payer.pubkey()),
            &[],
        );
        let _user_ata = init_ata(litesvm, mint, payer.pubkey(), 1_000_000);

        initialize_subscription_authority_action(litesvm, payer, mint)
            .0
            .assert_ok();

        let delegatee = Pubkey::new_unique();
        let wrong_pda = Pubkey::new_unique();

        let (res, _) = CreateDelegation::new(litesvm, payer, mint, delegatee)
            .pda(wrong_pda)
            .nonce(0)
            .fixed(100, 1000);

        assert!(res.is_err());
    }

    #[test]
    fn create_delegation_duplicate_nonce() {
        let (litesvm, user) = &mut setup();
        let payer = user;

        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            Some(payer.pubkey()),
            &[],
        );
        let _user_ata = init_ata(litesvm, mint, payer.pubkey(), 1_000_000);

        initialize_subscription_authority_action(litesvm, payer, mint)
            .0
            .assert_ok();

        let delegatee = Pubkey::new_unique();

        let (res, _) = CreateDelegation::new(litesvm, payer, mint, delegatee)
            .nonce(0)
            .fixed(100, current_ts() + 1000);
        res.assert_ok();

        let (res2, _) = CreateDelegation::new(litesvm, payer, mint, delegatee)
            .nonce(0)
            .fixed(200, current_ts() + 2000);
        res2.assert_err(SubscriptionsError::DelegationAlreadyExists);
    }

    #[test]
    fn create_multiple_delegations_different_nonces() {
        let (litesvm, user) = &mut setup();
        let payer = user;

        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            Some(payer.pubkey()),
            &[],
        );
        let _user_ata = init_ata(litesvm, mint, payer.pubkey(), 1_000_000);

        let (_, subscription_authority_pda, _) = initialize_subscription_authority_action(litesvm, payer, mint);

        let delegatee = Pubkey::new_unique();

        let (res0, pda0) = CreateDelegation::new(litesvm, payer, mint, delegatee)
            .nonce(0)
            .fixed(100, current_ts() + 1000);
        let tx = res0.assert_ok();
        println!(
            "Create Fixed delegation consumed: {} CUs",
            tx.compute_units_consumed
        );

        let (res1, pda1) = CreateDelegation::new(litesvm, payer, mint, delegatee)
            .nonce(1)
            .fixed(200, current_ts() + 2000);
        let tx = res1.assert_ok();
        println!(
            "Create Fixed delegation consumed: {} CUs",
            tx.compute_units_consumed
        );

        let (res2, pda2) = CreateDelegation::new(litesvm, payer, mint, delegatee)
            .nonce(2)
            .fixed(300, current_ts() + 3000);
        let tx = res2.assert_ok();
        println!(
            "Create Fixed delegation consumed: {} CUs",
            tx.compute_units_consumed
        );

        assert_ne!(pda0, pda1);
        assert_ne!(pda1, pda2);
        assert_ne!(pda0, pda2);

        let (expected_pda0, _) =
            get_delegation_pda(&subscription_authority_pda, &payer.pubkey(), &delegatee, 0);
        let (expected_pda1, _) =
            get_delegation_pda(&subscription_authority_pda, &payer.pubkey(), &delegatee, 1);
        let (expected_pda2, _) =
            get_delegation_pda(&subscription_authority_pda, &payer.pubkey(), &delegatee, 2);

        assert_eq!(pda0, expected_pda0);
        assert_eq!(pda1, expected_pda1);
        assert_eq!(pda2, expected_pda2);
    }

    #[test]
    fn writable_accounts_must_be_writable() {
        use solana_instruction::{AccountMeta, Instruction};

        use crate::{
            instructions::create_fixed_delegation,
            tests::{
                constants::PROGRAM_ID,
                idl,
                pda::get_subscription_authority_pda,
                utils::{build_and_send_transaction, init_wallet},
            },
        };

        let writable = idl::writable_account_indices("createFixedDelegation");

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

        initialize_subscription_authority_action(litesvm, user, mint)
            .0
            .assert_ok();

        let delegatee = Pubkey::new_unique();
        let nonce: u64 = 0;
        let (subscription_authority_pda, _) = get_subscription_authority_pda(&user.pubkey(), &mint);
        let (delegation_pda, _) = crate::tests::pda::get_delegation_pda(
            &subscription_authority_pda,
            &user.pubkey(),
            &delegatee,
            nonce,
        );

        for (idx, _name, is_signer) in &writable {
            let mut accounts = vec![
                AccountMeta::new(user.pubkey(), true),
                AccountMeta::new_readonly(subscription_authority_pda, false),
                AccountMeta::new(delegation_pda, false),
                AccountMeta::new_readonly(delegatee, false),
                AccountMeta::new_readonly(crate::tests::constants::SYSTEM_PROGRAM_ID, false),
            ];

            // Flip writable account to readonly, preserving signer flag
            let pubkey = accounts[*idx].pubkey;
            accounts[*idx] = AccountMeta::new_readonly(pubkey, *is_signer);

            let data = [
                vec![*create_fixed_delegation::DISCRIMINATOR],
                nonce.to_le_bytes().to_vec(),
                100u64.to_le_bytes().to_vec(),
                (current_ts() + 1000i64).to_le_bytes().to_vec(),
            ]
            .concat();

            let ix = Instruction {
                program_id: PROGRAM_ID,
                accounts,
                data,
            };

            let res =
                build_and_send_transaction(litesvm, &[&fee_payer, user], &fee_payer.pubkey(), &ix);
            res.assert_err(SubscriptionsError::AccountNotWritable);
        }
    }

    #[test]
    fn signer_accounts_must_be_signers() {
        use solana_instruction::{AccountMeta, Instruction};

        use crate::{
            instructions::create_fixed_delegation,
            tests::{
                constants::PROGRAM_ID,
                idl,
                pda::get_subscription_authority_pda,
                utils::{build_and_send_transaction, init_wallet},
            },
        };

        let signers = idl::signer_account_indices("createFixedDelegation");

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

        initialize_subscription_authority_action(litesvm, user, mint)
            .0
            .assert_ok();

        let delegatee = Pubkey::new_unique();
        let nonce: u64 = 0;
        let (subscription_authority_pda, _) = get_subscription_authority_pda(&user.pubkey(), &mint);
        let (delegation_pda, _) = crate::tests::pda::get_delegation_pda(
            &subscription_authority_pda,
            &user.pubkey(),
            &delegatee,
            nonce,
        );

        for (idx, _name, is_writable) in &signers {
            let mut accounts = vec![
                AccountMeta::new(user.pubkey(), true),
                AccountMeta::new_readonly(subscription_authority_pda, false),
                AccountMeta::new(delegation_pda, false),
                AccountMeta::new_readonly(delegatee, false),
                AccountMeta::new_readonly(crate::tests::constants::SYSTEM_PROGRAM_ID, false),
            ];

            // Flip signer to non-signer, preserving writable flag
            let pubkey = accounts[*idx].pubkey;
            accounts[*idx] = if *is_writable {
                AccountMeta::new(pubkey, false)
            } else {
                AccountMeta::new_readonly(pubkey, false)
            };

            let data = [
                vec![*create_fixed_delegation::DISCRIMINATOR],
                nonce.to_le_bytes().to_vec(),
                100u64.to_le_bytes().to_vec(),
                (current_ts() + 1000i64).to_le_bytes().to_vec(),
            ]
            .concat();

            let ix = Instruction {
                program_id: PROGRAM_ID,
                accounts,
                data,
            };

            let res = build_and_send_transaction(litesvm, &[&fee_payer], &fee_payer.pubkey(), &ix);
            res.assert_err(SubscriptionsError::NotSigner);
        }
    }

    #[test]
    fn create_fixed_delegation_with_expiry_in_past() {
        let (litesvm, user) = &mut setup();
        let payer = user;
        let amount: u64 = 100_000_000;
        let expiry_ts: i64 = -10000000;
        let nonce: u64 = 0;

        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            Some(payer.pubkey()),
            &[],
        );
        let _user_ata = init_ata(litesvm, mint, payer.pubkey(), 1_000_000);

        initialize_subscription_authority_action(litesvm, payer, mint)
            .0
            .assert_ok();

        let delegatee = Pubkey::new_unique();

        let (res, _delegation_pda) = CreateDelegation::new(litesvm, payer, mint, delegatee)
            .nonce(nonce)
            .fixed(amount, expiry_ts);
        res.assert_err(SubscriptionsError::FixedDelegationExpiryInPast);
    }

    #[test]
    fn create_fixed_delegation_with_zero_expiry() {
        let (litesvm, user) = &mut setup();
        let payer = user;
        let amount: u64 = 100_000_000;
        let expiry_ts: i64 = 0;
        let nonce: u64 = 0;

        let mint = init_mint(
            litesvm,
            TOKEN_PROGRAM_ID,
            MINT_DECIMALS,
            1_000_000_000,
            Some(payer.pubkey()),
            &[],
        );
        let _user_ata = init_ata(litesvm, mint, payer.pubkey(), 100_000_000);

        initialize_subscription_authority_action(litesvm, payer, mint)
            .0
            .assert_ok();

        let delegatee = solana_keypair::Keypair::new();
        litesvm.airdrop(&delegatee.pubkey(), 10_000_000).unwrap();
        let delegatee_ata = init_ata(litesvm, mint, delegatee.pubkey(), 0);

        let (res, delegation_pda) = CreateDelegation::new(litesvm, payer, mint, delegatee.pubkey())
            .nonce(nonce)
            .fixed(amount, expiry_ts);
        res.assert_ok();

        let account = litesvm.get_account(&delegation_pda).unwrap();
        let delegation = FixedDelegation::load(&account.data).unwrap();
        let del_expiry_ts = delegation.expiry_ts;
        assert_eq!(del_expiry_ts, 0);

        move_clock_forward(litesvm, days(30));

        let transfer_amount: u64 = 10_000_000;
        TransferDelegation::new(litesvm, &delegatee, payer.pubkey(), mint, delegation_pda)
            .amount(transfer_amount)
            .fixed()
            .assert_ok();

        assert_eq!(get_ata_balance(litesvm, &delegatee_ata), transfer_amount);
    }
}
