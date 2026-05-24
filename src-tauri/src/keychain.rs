use anyhow::{Context, Result};
use keyring::Entry;

const SERVICE: &str = "csvconv";
const KEY_API: &str = "api_key";
const KEY_PAID_ACK: &str = "paid_tier_ack";

fn entry(name: &str) -> Result<Entry> {
    Entry::new(SERVICE, name).context("failed to create keyring entry")
}

pub fn set_api_key(key: &str) -> Result<()> {
    entry(KEY_API)?
        .set_password(key)
        .context("failed to store API key")
}

pub fn get_api_key() -> Result<Option<String>> {
    match entry(KEY_API)?.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e).context("failed to read API key"),
    }
}

pub fn delete_api_key() -> Result<()> {
    match entry(KEY_API)?.delete_credential() {
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e).context("failed to delete API key"),
    }
}

pub fn set_paid_tier_acknowledged(ack: bool) -> Result<()> {
    let value = if ack { "true" } else { "false" };
    entry(KEY_PAID_ACK)?
        .set_password(value)
        .context("failed to store paid_tier_ack")
}

pub fn get_paid_tier_acknowledged() -> Result<bool> {
    match entry(KEY_PAID_ACK)?.get_password() {
        Ok(s) => Ok(s == "true"),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(e).context("failed to read paid_tier_ack"),
    }
}
