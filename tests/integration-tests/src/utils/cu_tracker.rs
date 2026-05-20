//! Compute Unit (CU) tracking utilities for benchmarking instruction costs.
//!
//! This module provides automatic CU tracking via a global tracker when the
//! `CU_REPORT` environment variable is set. Recording is skipped entirely
//! when the env var is not set to save CPU cycles.
//!
//! # Usage
//!
//! ```ignore
//! // Record directly from transaction result - instruction type is auto-detected
//! let result = build_and_send_transaction(...);
//! record_transaction(&result, &ix);
//!
//! // Report is automatically output when tests complete if CU_REPORT is set
//! ```

use std::borrow::ToOwned;
use std::collections::HashMap;
use std::fs::File;
use std::io::Write;
use std::string::{String, ToString};
use std::sync::Mutex;
use std::sync::OnceLock;
use std::vec::Vec;

use litesvm::types::TransactionResult;
use solana_instruction::Instruction;
use tabled::settings::Style;
use tabled::{Table, Tabled};

use crate::SubscriptionsInstruction;

static TRACKER: OnceLock<Mutex<CuTracker>> = OnceLock::new();

/// Check if CU tracking is enabled via CU_REPORT environment variable.
/// Caches the result to avoid repeated env lookups.
fn is_tracking_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    ENABLED.get_or_init(|| std::env::var("CU_REPORT").is_ok()).to_owned()
}

/// Global CU tracker shared across all tests.
fn global_tracker() -> &'static Mutex<CuTracker> {
    TRACKER.get_or_init(|| Mutex::new(CuTracker::new()))
}

/// Record a transaction result to the global tracker.
/// Parses instruction type from the provided instruction.
/// Only records if CU_REPORT environment variable is set.
/// Returns the CU consumed, or None if the transaction failed or tracking is disabled.
pub fn record_transaction(result: &TransactionResult, ix: &Instruction) -> Option<u64> {
    if !is_tracking_enabled() {
        return None;
    }
    global_tracker().lock().ok().and_then(|mut tracker| tracker.record(result, ix))
}

/// Output the CU report if the CU_REPORT environment variable is set.
/// Call this at the end of a test run to generate the markdown report.
pub fn output_report_if_enabled() {
    if is_tracking_enabled() {
        if let Ok(tracker) = global_tracker().lock() {
            tracker.print_table();
            if let Err(e) = tracker.write_to_file("cu_report.md") {
                eprintln!("Failed to write CU report: {}", e);
            }
        }
    }
}

const MICRO_LAMPORTS: u64 = 1_000_000;
const LAMPOSTS_PER_SOL: f64 = 1_000_000_000.0;
const BASE_FEE_LAMPORTS: u64 = 5_000;

// Different rate for Microlamports per CU
const RATE_LOW: u64 = 300;
const RATE_MED: u64 = 40_000;
const RATE_HIGH: u64 = 500_000;

/// Calculate estimated SOL cost for a given CU amount at a specific priority rate
fn calculate_sol_cost(cu: u64, rate: u64) -> f64 {
    let priority_fee_micro = cu * rate;
    let priority_fee_lamports = priority_fee_micro / MICRO_LAMPORTS;
    let total_lamports = BASE_FEE_LAMPORTS + priority_fee_lamports;
    total_lamports as f64 / LAMPOSTS_PER_SOL
}

/// Statistics for a single instruction type (displayed in table).
#[derive(Debug, Clone, Tabled)]
pub struct InstructionStats {
    #[tabled(rename = "Instruction")]
    pub instruction: String,
    #[tabled(rename = "Samples")]
    pub count: usize,
    #[tabled(rename = "Min CUs")]
    pub min: u64,
    #[tabled(rename = "Max CUs")]
    pub max: u64,
    #[tabled(rename = "Avg CUs")]
    pub avg: u64,
    #[tabled(rename = "Est Cost (Low) [SOL]")]
    pub cost_low: String,
    #[tabled(rename = "Est Cost (Med) [SOL]")]
    pub cost_med: String,
    #[tabled(rename = "Est Cost (High) [SOL]")]
    pub cost_high: String,
}

/// Tracker for collecting CU measurements across multiple instructions.
/// Groups measurements by instruction type and computes statistics.
#[derive(Debug)]
pub struct CuTracker {
    /// Maps instruction name to list of CU measurements
    measurements: HashMap<String, Vec<u64>>,
}

impl CuTracker {
    /// Create a new empty tracker.
    pub fn new() -> Self {
        Self { measurements: HashMap::new() }
    }

    /// Record CU from a transaction result.
    /// Parses instruction type from the provided instruction.
    /// Returns the CU consumed, or None if the transaction failed.
    pub fn record(&mut self, result: &TransactionResult, ix: &Instruction) -> Option<u64> {
        if !is_tracking_enabled() {
            return None;
        }

        let tx = result.as_ref().ok()?;

        if let Ok(instruction) = SubscriptionsInstruction::from_bytes(&ix.data) {
            let instruction_name = instruction.to_string();
            self.measurements.entry(instruction_name).or_default().push(tx.compute_units_consumed);
        }

        Some(tx.compute_units_consumed)
    }

    /// Get the total number of recorded measurements.
    pub fn len(&self) -> usize {
        self.measurements.values().map(|v| v.len()).sum()
    }

    /// Check if tracker has no measurements.
    pub fn is_empty(&self) -> bool {
        self.measurements.is_empty()
    }

    /// Compute statistics for each instruction type.
    fn compute_stats(&self) -> Vec<InstructionStats> {
        let mut stats: Vec<InstructionStats> = self
            .measurements
            .iter()
            .map(|(instruction, measurements)| {
                let count = measurements.len();
                let min = *measurements.iter().min().unwrap_or(&0);
                let max = *measurements.iter().max().unwrap_or(&0);
                let avg = if count > 0 { measurements.iter().sum::<u64>() / count as u64 } else { 0 };

                let cost_low = format!("{:.9}", calculate_sol_cost(avg, RATE_LOW));
                let cost_med = format!("{:.9}", calculate_sol_cost(avg, RATE_MED));
                let cost_high = format!("{:.9}", calculate_sol_cost(avg, RATE_HIGH));

                InstructionStats {
                    instruction: instruction.clone(),
                    count,
                    min,
                    max,
                    avg,
                    cost_low,
                    cost_med,
                    cost_high,
                }
            })
            .collect();

        // Sort by instruction name for consistent output
        stats.sort_by(|a, b| a.instruction.cmp(&b.instruction));
        stats
    }

    /// Generate a markdown-formatted report using tabled's Style::markdown().
    pub fn to_markdown(&self) -> String {
        if self.is_empty() {
            return String::from("No CU measurements recorded.");
        }

        let stats = self.compute_stats();

        let mut output = String::new();
        output.push_str("# Compute Unit Report\n\n");
        output.push_str(&Table::new(&stats).with(Style::markdown()).to_string());
        output.push_str(&format!("\n\n*Generated: {}*\n", report_date()));

        output
    }

    /// Print a formatted table to stdout.
    pub fn print_table(&self) {
        if self.is_empty() {
            println!("No CU measurements recorded.");
            return;
        }

        let stats = self.compute_stats();
        println!("\n{}", Table::new(&stats));
    }

    /// Write the markdown report to a file.
    pub fn write_to_file(&self, path: &str) -> std::io::Result<()> {
        let markdown = self.to_markdown();
        let mut file = File::create(path)?;
        file.write_all(markdown.as_bytes())?;
        println!("CU report written to: {}", path);
        Ok(())
    }

    /// Check if CU_REPORT environment variable is set and write report if so.
    /// Returns true if report was written.
    pub fn write_if_enabled(&self, path: &str) -> bool {
        if is_tracking_enabled() {
            if let Err(e) = self.write_to_file(path) {
                eprintln!("Failed to write CU report: {}", e);
                return false;
            }
            return true;
        }
        false
    }
}

impl Default for CuTracker {
    fn default() -> Self {
        Self::new()
    }
}

/// Destructor that runs after all tests complete.
/// This runs when the test binary exits, ensuring the CU report is generated
/// after all parallel tests have finished.
#[dtor::dtor(unsafe)]
fn output_cu_report_on_exit() {
    output_report_if_enabled();
}

fn report_date() -> String {
    std::env::var("CU_REPORT_DATE").unwrap_or_default()
}
