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
  /** Skew angle (deg) applied to the page; the crop step re-applies it so boxes stay aligned. */
  skew_angle_deg: number;
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

/** Copy the source PDF into the app data dir (keyed by sha256); returns the stored path. */
export async function storeSourcePdf(pdfPath: string, sha256: string): Promise<string> {
  return invoke<string>("store_source_pdf", { pdfPath, sha256 });
}

export async function cleanupStaging(runId: string): Promise<void> {
  await invoke("cleanup_staging", { runId });
}

export interface CropJob {
  jobId: string;
  /** Source PDF — re-rendered at high DPI for a crisp crop instead of cropping the page JPEG. */
  pdfPath: string;
  password?: string | null;
  pageNumber: number;
  destPath: string;
  /** DPI to render the source page at before cropping. */
  renderDpi: number;
  /** Same skew angle rasterize applied to this page, so the box still lines up. */
  skewAngleDeg: number;
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

/**
 * Copy figure crops into the device's public Downloads/<subdir>/ folder (via
 * MediaStore on Android, ~/Downloads on desktop) so they're visible in the file
 * manager and ready to upload. Returns how many files were written.
 */
export async function exportFiguresToDownloads(
  figurePaths: string[],
  subdir: string,
): Promise<number> {
  return invoke<number>("export_figures_to_downloads", { figurePaths, subdir });
}

/**
 * Bundle figure crops into a single ZIP in the app data dir and return its path. Used on
 * Android, where the frontend then copies the zip out to a user-chosen location via the
 * fs plugin save dialog (the reliable content:// path), instead of writing many files via
 * the fragile MediaStore route.
 */
export async function zipFigures(figurePaths: string[], fileName: string): Promise<string> {
  return invoke<string>("zip_figures", { figurePaths, fileName });
}
