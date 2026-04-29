use std::string::String;

use crate::errors::SubscriptionsError;

use litesvm::types::{FailedTransactionMetadata, TransactionMetadata, TransactionResult};
use solana_instruction::error::InstructionError;
use solana_transaction_error::TransactionError;

pub trait TransactionResultExt {
    /// Assert transaction succeeded and return the metadata
    fn assert_ok(self) -> TransactionMetadata;

    /// Assert transaction failed with the expected error
    fn assert_err(self, expected: SubscriptionsError);
}

impl TransactionResultExt for TransactionResult {
    fn assert_ok(self) -> TransactionMetadata {
        match self {
            Ok(meta) => meta,
            Err(failed_tx) => {
                let error_msg = format_error(&failed_tx);
                panic!(
                    "Expected transaction to succeed, but got: {}\nLogs:\n{}",
                    error_msg,
                    failed_tx.meta.logs.join("\n")
                );
            }
        }
    }

    fn assert_err(self, expected: SubscriptionsError) {
        match self {
            Ok(_) => panic!(
                "Expected transaction to fail with {:?} ({})",
                expected, expected
            ),
            Err(failed_tx) => {
                let expected_err = TransactionError::InstructionError(
                    0,
                    InstructionError::Custom(expected as u32),
                );
                if failed_tx.err != expected_err {
                    let actual_msg = format_error(&failed_tx);
                    panic!(
                        "Expected: {:?}:{} \nGot: {}\n\nLogs:\n{}",
                        expected,
                        expected,
                        actual_msg,
                        failed_tx.meta.logs.join("\n")
                    );
                }
            }
        }
    }
}

fn format_error(failed_tx: &FailedTransactionMetadata) -> String {
    match &failed_tx.err {
        TransactionError::InstructionError(_, InstructionError::Custom(code)) => {
            match SubscriptionsError::try_from(*code) {
                Ok(err) => format!("{:?}: {}", err, err),
                Err(code) => format!("Unknown custom error code: {}", code),
            }
        }
        other => format!("{:?}", other),
    }
}
