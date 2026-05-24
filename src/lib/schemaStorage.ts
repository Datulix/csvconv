import { invoke } from "@tauri-apps/api/core";
import type { Schema } from "../schema/types";

export interface SavedSchemaEntry {
  name: string;
  content: Schema;
}

interface RawSavedSchema {
  name: string;
  content: unknown;
}

export async function saveSchema(schema: Schema): Promise<string> {
  return invoke<string>("save_schema", {
    name: schema.name,
    content: schema,
  });
}

export async function loadSchemas(): Promise<SavedSchemaEntry[]> {
  const raw = await invoke<RawSavedSchema[]>("load_schemas");
  return raw.map((r) => ({ name: r.name, content: r.content as Schema }));
}

export async function deleteSchema(name: string): Promise<void> {
  await invoke("delete_schema", { name });
}
