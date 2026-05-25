import { invoke } from "@tauri-apps/api/core";

export type PageType = "digital" | "scanned";

export interface TriagePageInfo {
  page_number: number;
  is_blank: boolean;
  page_type: PageType;
  text_density: number;
  skew_angle_deg: number;
}

export type PdfType = "digital" | "scanned" | "mixed";

export interface TriageResult {
  pdf_type: PdfType;
  pages: TriagePageInfo[];
}

export interface RasterizedPage {
  page_number: number;
  path: string;
  width: number;
  height: number;
  deskewed: boolean;
  skipped: boolean;
}

export interface RasterizeResult {
  staging_dir: string;
  pages: RasterizedPage[];
}

export interface RasterizeOptions {
  path: string;
  dpi: number;
  runId: string;
  password?: string;
  deskewPages?: number[];
  skewAngles?: Array<[number, number]>;
  skipPages?: number[];
  onlyPages?: number[];
}

export async function triagePdf(
  path: string,
  runId: string,
  password?: string,
): Promise<TriageResult> {
  return invoke<TriageResult>("triage_pdf", {
    path,
    runId,
    password,
  });
}

export async function rasterizePdf(opts: RasterizeOptions): Promise<RasterizeResult> {
  return invoke<RasterizeResult>("rasterize_pdf", {
    path: opts.path,
    dpi: opts.dpi,
    runId: opts.runId,
    password: opts.password,
    deskewPages: opts.deskewPages,
    skewAngles: opts.skewAngles,
    skipPages: opts.skipPages,
    onlyPages: opts.onlyPages,
  });
}

export async function readImageAsBase64(path: string): Promise<string> {
  return invoke<string>("read_image_as_base64", { path });
}

export async function cleanupStaging(runId: string): Promise<void> {
  await invoke("cleanup_staging", { runId });
}

export interface CropJob {
  jobId: string;
  srcPath: string;
  destPath: string;
  ymin: number;
  xmin: number;
  ymax: number;
  xmax: number;
}

export interface CropResult {
  jobId: string;
  ok: boolean;
  error?: string | null;
  width: number;
  height: number;
}

export async function cropFiguresBatch(jobs: CropJob[]): Promise<CropResult[]> {
  return invoke<CropResult[]>("crop_figures_batch", { jobs });
}

export async function figuresDir(cacheKey: string): Promise<string> {
  return invoke<string>("figures_dir", { cacheKey });
}

export async function cleanupFigures(cacheKey: string): Promise<void> {
  await invoke("cleanup_figures", { cacheKey });
}
