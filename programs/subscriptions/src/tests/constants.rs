use solana_pubkey::Pubkey;

pub static SYSTEM_PROGRAM_ID: Pubkey = Pubkey::new_from_array(pinocchio_system::ID.to_bytes());
pub static TOKEN_PROGRAM_ID: Pubkey = Pubkey::new_from_array(pinocchio_token::ID.to_bytes());
pub static TOKEN_2022_PROGRAM_ID: Pubkey =
    Pubkey::new_from_array(pinocchio_token_2022::ID.to_bytes());
pub static ASSOCIATED_TOKEN_PROGRAM_ID: Pubkey =
    Pubkey::new_from_array(pinocchio_associated_token_account::ID.to_bytes());

pub static PROGRAM_ID: Pubkey = Pubkey::new_from_array(crate::ID.to_bytes());
pub const MINT_DECIMALS: u8 = 6;
