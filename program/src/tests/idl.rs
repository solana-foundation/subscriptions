use std::string::{String, ToString};
use std::vec::Vec;

use serde_json::Value;

const IDL_JSON: &str = include_str!("../../../idl/subscriptions.json");

/// Account info from the IDL.
pub struct IdlAccount {
    pub index: usize,
    pub name: String,
    pub is_writable: bool,
    pub is_signer: bool,
}

/// Returns account metadata for all accounts of the given instruction.
pub fn instruction_accounts(instruction_name: &str) -> Vec<IdlAccount> {
    let idl: Value = serde_json::from_str(IDL_JSON).unwrap();
    let instructions = idl["program"]["instructions"].as_array().unwrap();
    let ix = instructions
        .iter()
        .find(|ix| ix["name"].as_str().unwrap() == instruction_name)
        .unwrap_or_else(|| panic!("Instruction '{}' not found in IDL", instruction_name));
    ix["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .map(|(i, acc)| IdlAccount {
            index: i,
            name: acc["name"].as_str().unwrap().to_string(),
            is_writable: acc["isWritable"].as_bool().unwrap(),
            is_signer: acc["isSigner"].as_bool().unwrap(),
        })
        .collect()
}

/// Returns (index, name, is_signer) for writable accounts.
pub fn writable_account_indices(instruction_name: &str) -> Vec<(usize, String, bool)> {
    instruction_accounts(instruction_name)
        .into_iter()
        .filter(|a| a.is_writable)
        .map(|a| (a.index, a.name, a.is_signer))
        .collect()
}

/// Returns (index, name, is_writable) for signer accounts.
pub fn signer_account_indices(instruction_name: &str) -> Vec<(usize, String, bool)> {
    instruction_accounts(instruction_name)
        .into_iter()
        .filter(|a| a.is_signer)
        .map(|a| (a.index, a.name, a.is_writable))
        .collect()
}
