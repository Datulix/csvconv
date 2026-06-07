import { invoke } from "@tauri-apps/api/core";
import type { ModelId } from "./models";

export interface AppSettings {
  primary_model: ModelId | null;
  detector_model: ModelId | null;
  analyzer_model: ModelId | null;
  extractor_model: ModelId | null;
  validator_model: ModelId | null;
  solver_model: ModelId | null;
  dpi: number;
  pages_per_batch: number;
  parallel_batches: number;
  confidence_threshold: number;
  validator_enabled: boolean;
  image_base_url: string | null;
}

export const DEFAULT_SETTINGS: AppSettings = {
  primary_model: null,
  detector_model: null,
  analyzer_model: null,
  extractor_model: null,
  validator_model: null,
  solver_model: null,
  dpi: 300,
  pages_per_batch: 10,
  parallel_batches: 3,
  confidence_threshold: 0.75,
  validator_enabled: true,
  image_base_url: null,
};

export async function loadSettings(): Promise<AppSettings> {
  return invoke<AppSettings>("load_settings");
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await invoke("save_settings", { settingsIn: settings });
}

export async function setApiKey(key: string): Promise<void> {
  await invoke("keychain_set_api_key", { key });
}

export async function getApiKey(): Promise<string | null> {
  return invoke<string | null>("keychain_get_api_key");
}

export async function deleteApiKey(): Promise<void> {
  await invoke("keychain_delete_api_key");
}

export async function setPaidTierAck(ack: boolean): Promise<void> {
  await invoke("keychain_set_paid_tier_ack", { ack });
}

export async function getPaidTierAck(): Promise<boolean> {
  return invoke<boolean>("keychain_get_paid_tier_ack");
}
