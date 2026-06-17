use anyhow::{Context, Result};
use image::DynamicImage;
use pdfium_render::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

const MAX_LONG_EDGE: u32 = 2048;
const JPEG_QUALITY: u8 = 82;
const POINTS_PER_INCH: f32 = 72.0;
/// Below this character count a page is treated as a scanned image and becomes
/// a candidate for automatic skew correction (mirrors triage's DIGITAL_THRESHOLD).
const SCANNED_TEXT_THRESHOLD: u32 = 50;
/// Minimum absolute skew angle (degrees) worth correcting — below this the
/// rotation cost/interpolation blur isn't worth it.
const MIN_DESKEW_ANGLE: f32 = 1.0;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct RasterizedPage {
    pub page_number: u32,
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub deskewed: bool,
    /// Skew angle (degrees) actually applied to this page; 0.0 if none. The
    /// figure-crop step re-applies this exact angle so box coordinates stay aligned.
    pub skew_angle_deg: f32,
    pub skipped: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct RasterizeResult {
    pub staging_dir: String,
    pub pages: Vec<RasterizedPage>,
}

pub fn rasterize(
    pdfium: &Pdfium,
    pdf_path: &str,
    dpi: u32,
    staging_dir: &Path,
    password: Option<&str>,
    deskew_pages: &[u32],
    skew_angles: &[(u32, f32)],
    skip_pages: &[u32],
    only_pages: Option<&[u32]>,
) -> Result<RasterizeResult> {
    fs::create_dir_all(staging_dir)
        .with_context(|| format!("failed to create staging dir: {}", staging_dir.display()))?;

    let doc = pdfium
        .load_pdf_from_file(pdf_path, password)
        .with_context(|| format!("failed to open PDF: {pdf_path}"))?;

    let deskew_set: HashSet<u32> = deskew_pages.iter().copied().collect();
    let skip_set: HashSet<u32> = skip_pages.iter().copied().collect();
    let only_set: Option<HashSet<u32>> = only_pages.map(|p| p.iter().copied().collect());
    let mut pages_out: Vec<RasterizedPage> = Vec::new();

    for (index, page) in doc.pages().iter().enumerate() {
        let page_number = (index + 1) as u32;

        if let Some(ref only) = only_set {
            if !only.contains(&page_number) {
                continue;
            }
        }

        if skip_set.contains(&page_number) {
            pages_out.push(RasterizedPage {
                page_number,
                path: String::new(),
                width: 0,
                height: 0,
                deskewed: false,
                skew_angle_deg: 0.0,
                skipped: true,
            });
            continue;
        }

        let page_width_points = page.width().value;
        let page_height_points = page.height().value;
        let mut target_width = (page_width_points / POINTS_PER_INCH * dpi as f32).round() as u32;
        let mut target_height = (page_height_points / POINTS_PER_INCH * dpi as f32).round() as u32;
        let max_dim = target_width.max(target_height);
        if max_dim > MAX_LONG_EDGE {
            let scale = MAX_LONG_EDGE as f32 / max_dim as f32;
            target_width = ((target_width as f32) * scale).round() as u32;
            target_height = ((target_height as f32) * scale).round() as u32;
        }
        target_width = target_width.max(1);
        target_height = target_height.max(1);

        let bitmap = page
            .render_with_config(
                &PdfRenderConfig::new()
                    .set_target_width(target_width as Pixels)
                    .set_target_height(target_height as Pixels)
                    .render_form_data(true),
            )
            .with_context(|| format!("failed to render page {page_number}"))?;

        let mut image: DynamicImage = bitmap.as_image();

        // Determine the skew angle to correct. An explicit caller-supplied angle
        // (deskew_set + skew_angles) always wins; otherwise auto-estimate for pages
        // that look like scanned images (low extractable-text density).
        let candidate_angle = if deskew_set.contains(&page_number) {
            skew_angles
                .iter()
                .find(|(pn, _)| *pn == page_number)
                .map(|(_, a)| *a)
                .unwrap_or(0.0)
        } else {
            let text_density = page
                .text()
                .map(|t| t.all().chars().count() as u32)
                .unwrap_or(0);
            if text_density < SCANNED_TEXT_THRESHOLD {
                crate::triage::estimate_skew(&page).unwrap_or(0.0)
            } else {
                0.0
            }
        };

        let (deskewed, applied_angle) = if candidate_angle.abs() >= MIN_DESKEW_ANGLE {
            image = deskew_image(&image, candidate_angle);
            (true, candidate_angle)
        } else {
            (false, 0.0)
        };

        let (w, h) = (image.width(), image.height());
        let path = staging_dir.join(format!("page-{page_number}.jpg"));
        save_jpeg(&image, &path, JPEG_QUALITY)?;

        pages_out.push(RasterizedPage {
            page_number,
            path: path.to_string_lossy().to_string(),
            width: w,
            height: h,
            deskewed,
            skew_angle_deg: applied_angle,
            skipped: false,
        });
    }

    Ok(RasterizeResult {
        staging_dir: staging_dir.to_string_lossy().to_string(),
        pages: pages_out,
    })
}

/// Render a single page of a PDF to an in-memory JPEG and return it base64-encoded.
/// Used by the Review "Show PDF" panel: the WebView (notably Android System WebView)
/// can't display a PDF in an iframe, so we hand it a plain image instead. 1-based page.
pub fn render_page_base64(
    pdfium: &Pdfium,
    pdf_path: &str,
    page_number: u32,
    dpi: u32,
) -> Result<String> {
    use base64::Engine;

    let doc = pdfium
        .load_pdf_from_file(pdf_path, None)
        .with_context(|| format!("failed to open PDF: {pdf_path}"))?;
    let pages = doc.pages();
    let count = pages.len();
    if page_number < 1 || page_number as u16 > count {
        anyhow::bail!("page {page_number} out of range (1..={count})");
    }
    let page = pages
        .get((page_number - 1) as u16)
        .with_context(|| format!("failed to load page {page_number}"))?;

    let page_width_points = page.width().value;
    let page_height_points = page.height().value;
    let mut target_width = (page_width_points / POINTS_PER_INCH * dpi as f32).round() as u32;
    let mut target_height = (page_height_points / POINTS_PER_INCH * dpi as f32).round() as u32;
    let max_dim = target_width.max(target_height);
    if max_dim > MAX_LONG_EDGE {
        let scale = MAX_LONG_EDGE as f32 / max_dim as f32;
        target_width = ((target_width as f32) * scale).round() as u32;
        target_height = ((target_height as f32) * scale).round() as u32;
    }
    target_width = target_width.max(1);
    target_height = target_height.max(1);

    let bitmap = page
        .render_with_config(
            &PdfRenderConfig::new()
                .set_target_width(target_width as Pixels)
                .set_target_height(target_height as Pixels)
                .render_form_data(true),
        )
        .with_context(|| format!("failed to render page {page_number}"))?;
    let image: DynamicImage = bitmap.as_image();

    let mut buf: Vec<u8> = Vec::new();
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, JPEG_QUALITY);
    image
        .write_with_encoder(encoder)
        .context("failed to encode page JPEG")?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&buf))
}

fn deskew_image(image: &DynamicImage, angle_deg: f32) -> DynamicImage {
    let radians = -angle_deg.to_radians();
    let rgba = image.to_rgba8();
    let rotated = imageproc::geometric_transformations::rotate_about_center(
        &rgba,
        radians,
        imageproc::geometric_transformations::Interpolation::Bilinear,
        image::Rgba([255u8, 255, 255, 255]),
    );
    DynamicImage::ImageRgba8(rotated)
}

fn save_jpeg(image: &DynamicImage, path: &PathBuf, quality: u8) -> Result<()> {
    let rgb = image.to_rgb8();
    let mut file = fs::File::create(path)
        .with_context(|| format!("failed to create JPEG: {}", path.display()))?;
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut file, quality);
    let dyn_rgb = DynamicImage::ImageRgb8(rgb);
    dyn_rgb
        .write_with_encoder(encoder)
        .with_context(|| format!("failed to encode JPEG: {}", path.display()))?;
    Ok(())
}

pub fn cleanup_staging(staging_dir: &Path) -> Result<()> {
    if staging_dir.exists() {
        fs::remove_dir_all(staging_dir).with_context(|| {
            format!("failed to remove staging dir: {}", staging_dir.display())
        })?;
    }
    Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CropJob {
    pub job_id: String,        // caller-supplied; echoed back in result
    pub pdf_path: String,      // source PDF — re-rendered at high DPI for a crisp crop
    pub password: Option<String>,
    pub page_number: u32,      // 1-based
    pub dest_path: String,     // absolute path in figures/<cache_key>/
    pub render_dpi: u32,       // DPI to render the source page at before cropping
    pub skew_angle_deg: f32,   // same angle rasterize applied, so the box still lines up
    pub ymin: u32, pub xmin: u32, pub ymax: u32, pub xmax: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CropResult {
    pub job_id: String,
    pub ok: bool,
    pub error: Option<String>,
    pub width: u32, pub height: u32,
}

const FIGURE_PADDING_PCT: f32 = 0.015;       // 1.5% padding on each edge
const MIN_AREA_FRAC: f32 = 0.005;            // reject < 0.5% page area
const MAX_AREA_FRAC: f32 = 0.95;             // reject > 95% page area
const FIGURE_JPEG_QUALITY: u8 = 92;          // higher quality than page raster
/// Crops are rendered fresh from the PDF, so they get a far higher resolution
/// ceiling than the page raster (whose 2048px cap is fine for sending to the model).
const FIGURE_MAX_LONG_EDGE: u32 = 4096;

/// Render a single page from the PDF at the requested DPI (capped at
/// FIGURE_MAX_LONG_EDGE) and apply the given skew correction. This is the same
/// transform rasterize() used, so normalized boxes map onto it 1:1.
fn render_page_for_crop(
    pdfium: &Pdfium,
    pdf_path: &str,
    password: Option<&str>,
    page_number: u32,
    dpi: u32,
    skew_angle_deg: f32,
) -> Result<DynamicImage> {
    let doc = pdfium
        .load_pdf_from_file(pdf_path, password)
        .with_context(|| format!("failed to open PDF: {pdf_path}"))?;
    let page = doc
        .pages()
        .get((page_number - 1) as u16)
        .with_context(|| format!("page {page_number} out of range"))?;

    let page_width_points = page.width().value;
    let page_height_points = page.height().value;
    let mut target_width = (page_width_points / POINTS_PER_INCH * dpi as f32).round() as u32;
    let mut target_height = (page_height_points / POINTS_PER_INCH * dpi as f32).round() as u32;
    let max_dim = target_width.max(target_height);
    if max_dim > FIGURE_MAX_LONG_EDGE {
        let scale = FIGURE_MAX_LONG_EDGE as f32 / max_dim as f32;
        target_width = ((target_width as f32) * scale).round() as u32;
        target_height = ((target_height as f32) * scale).round() as u32;
    }
    target_width = target_width.max(1);
    target_height = target_height.max(1);

    let bitmap = page
        .render_with_config(
            &PdfRenderConfig::new()
                .set_target_width(target_width as Pixels)
                .set_target_height(target_height as Pixels)
                .render_form_data(true),
        )
        .with_context(|| format!("failed to render page {page_number}"))?;
    let mut image = bitmap.as_image();

    if skew_angle_deg.abs() >= MIN_DESKEW_ANGLE {
        image = deskew_image(&image, skew_angle_deg);
    }
    Ok(image)
}

/// Extra margin (fraction of box size) cropped around a figure before rotating,
/// so straightening pulls real content into the corners instead of white fill.
const FIGURE_ROT_MARGIN_PCT: f32 = 0.18;
/// Minimum supporting Hough lines before we trust a per-figure tilt estimate.
/// Higher than the page-level gate (1) so we don't rotate on edge noise.
const FIGURE_MIN_LINES: usize = 6;
/// Width the figure is downscaled to for tilt detection, so Hough thresholds
/// behave consistently regardless of the crop's native resolution.
const FIGURE_ANALYSIS_WIDTH: u32 = 400;
/// A pixel counts as background when its luma is at least this bright.
const TRIM_WHITE_LUMA: u8 = 240;
/// A row/column is "empty" (trimmable) when at most this fraction of its pixels
/// are non-white — a small tolerance for JPEG speckle without clipping content.
const TRIM_NONWHITE_TOLERANCE: f32 = 0.005;
/// Never trim more than this fraction off any single side, so a detection glitch
/// can't shrink a figure to nothing.
const TRIM_MAX_FRAC: f32 = 0.30;

/// Remove near-white background margins from the edges of a figure crop. Scans
/// inward from each side and drops rows/columns that are essentially all white,
/// stopping at the first row/column containing content — so it can never clip a
/// label or caption. Capped per side and guarded against degenerate results.
fn trim_near_white_border(img: &DynamicImage) -> DynamicImage {
    let gray = img.to_luma8();
    let (w, h) = (gray.width(), gray.height());
    if w < 8 || h < 8 {
        return img.clone();
    }

    let row_empty = |y: u32| -> bool {
        let mut nonwhite = 0u32;
        for x in 0..w {
            if gray.get_pixel(x, y)[0] < TRIM_WHITE_LUMA {
                nonwhite += 1;
            }
        }
        (nonwhite as f32) <= (w as f32) * TRIM_NONWHITE_TOLERANCE
    };
    let col_empty = |x: u32| -> bool {
        let mut nonwhite = 0u32;
        for y in 0..h {
            if gray.get_pixel(x, y)[0] < TRIM_WHITE_LUMA {
                nonwhite += 1;
            }
        }
        (nonwhite as f32) <= (h as f32) * TRIM_NONWHITE_TOLERANCE
    };

    let mut top = 0u32;
    while top < h && row_empty(top) { top += 1; }
    let mut bottom = h; // exclusive
    while bottom > top && row_empty(bottom - 1) { bottom -= 1; }
    let mut left = 0u32;
    while left < w && col_empty(left) { left += 1; }
    let mut right = w; // exclusive
    while right > left && col_empty(right - 1) { right -= 1; }

    // If the scan found no content at all (essentially blank crop), leave it be —
    // checked on the raw bounds before the cap, which would otherwise manufacture
    // a bogus region out of a fully-empty image.
    if top >= bottom || left >= right {
        return img.clone();
    }

    // Cap how much can come off each side.
    let max_tx = ((w as f32) * TRIM_MAX_FRAC) as u32;
    let max_ty = ((h as f32) * TRIM_MAX_FRAC) as u32;
    let top = top.min(max_ty);
    let left = left.min(max_tx);
    let bottom = bottom.max(h - max_ty);
    let right = right.max(w - max_tx);

    let (nw, nh) = (right - left, bottom - top);
    if nw < 8 || nh < 8 {
        return img.clone();
    }
    img.crop_imm(left, top, nw, nh)
}

/// Translate a normalized 0..1000 box into a padded, area-checked, clamped pixel
/// rect `(x, y, w, h)` on a rendered page image. Pure math — unit-testable.
fn figure_pixel_rect(
    iw: u32, ih: u32,
    xmin: u32, ymin: u32, xmax: u32, ymax: u32,
) -> Result<(u32, u32, u32, u32)> {
    let (w, h) = (iw as f32, ih as f32);

    let pad = FIGURE_PADDING_PCT * 1000.0;
    let xmin_n = (xmin as f32 - pad).max(0.0);
    let ymin_n = (ymin as f32 - pad).max(0.0);
    let xmax_n = (xmax as f32 + pad).min(1000.0);
    let ymax_n = (ymax as f32 + pad).min(1000.0);

    let x = (xmin_n / 1000.0 * w).round() as u32;
    let y = (ymin_n / 1000.0 * h).round() as u32;
    let cw = (((xmax_n - xmin_n) / 1000.0) * w).round() as u32;
    let ch = (((ymax_n - ymin_n) / 1000.0) * h).round() as u32;

    let area_frac = (cw as f32 * ch as f32) / (w * h);
    if area_frac < MIN_AREA_FRAC { anyhow::bail!("box too small ({:.3}%)", area_frac*100.0); }
    if area_frac > MAX_AREA_FRAC { anyhow::bail!("box covers full page ({:.1}%)", area_frac*100.0); }

    let cw = cw.max(1).min(iw.saturating_sub(x).max(1));
    let ch = ch.max(1).min(ih.saturating_sub(y).max(1));
    Ok((x, y, cw, ch))
}

/// Crop a normalized 0..1000 box out of a rendered page image (no straightening).
#[cfg(test)]
fn crop_region(
    img: &DynamicImage,
    xmin: u32, ymin: u32, xmax: u32, ymax: u32,
) -> Result<DynamicImage> {
    let (x, y, cw, ch) = figure_pixel_rect(img.width(), img.height(), xmin, ymin, xmax, ymax)?;
    Ok(img.crop_imm(x, y, cw, ch))
}

/// Crop a figure and straighten it in place: detect the figure's own tilt and
/// rotate about its centre so an individually-skewed photo (common in scanned
/// exam pages) comes out upright. Falls back to a plain crop when no confident
/// angle is found, so figures without a clear rectangular border are untouched.
fn crop_and_straighten(
    img: &DynamicImage,
    xmin: u32, ymin: u32, xmax: u32, ymax: u32,
) -> Result<DynamicImage> {
    let (x, y, cw, ch) = figure_pixel_rect(img.width(), img.height(), xmin, ymin, xmax, ymax)?;

    // Expand the crop so the rotation has headroom and corners pull real content.
    let ex = ((cw as f32) * FIGURE_ROT_MARGIN_PCT).round() as u32;
    let ey = ((ch as f32) * FIGURE_ROT_MARGIN_PCT).round() as u32;
    let px = x.saturating_sub(ex);
    let py = y.saturating_sub(ey);
    let pcw = (cw + 2 * ex).min(img.width().saturating_sub(px).max(1));
    let pch = (ch + 2 * ey).min(img.height().saturating_sub(py).max(1));
    let padded = img.crop_imm(px, py, pcw, pch);

    // The figure's box origin relative to the padded crop.
    let off_x = x - px;
    let off_y = y - py;

    // Estimate the figure's tilt from a downscaled grayscale copy.
    let gray = padded.to_luma8();
    let analysis = if gray.width() > FIGURE_ANALYSIS_WIDTH {
        let nh = ((FIGURE_ANALYSIS_WIDTH as f32 / gray.width() as f32) * gray.height() as f32)
            .round()
            .max(1.0) as u32;
        image::imageops::resize(
            &gray,
            FIGURE_ANALYSIS_WIDTH,
            nh,
            image::imageops::FilterType::Triangle,
        )
    } else {
        gray
    };
    let angle = crate::triage::estimate_skew_luma(&analysis, FIGURE_MIN_LINES);

    let figure = if angle.abs() < MIN_DESKEW_ANGLE {
        // No confident tilt — take the straight crop (figure box within padded).
        let fcw = cw.min(padded.width().saturating_sub(off_x).max(1));
        let fch = ch.min(padded.height().saturating_sub(off_y).max(1));
        padded.crop_imm(off_x, off_y, fcw, fch)
    } else {
        // Rotate about the figure's centre so it stays framed, then crop the box window.
        let rgba = padded.to_rgba8();
        let center = (off_x as f32 + cw as f32 / 2.0, off_y as f32 + ch as f32 / 2.0);
        let rotated = imageproc::geometric_transformations::rotate(
            &rgba,
            center,
            -angle.to_radians(),
            imageproc::geometric_transformations::Interpolation::Bilinear,
            image::Rgba([255u8, 255, 255, 255]),
        );
        let rotated = DynamicImage::ImageRgba8(rotated);
        let fcw = cw.min(rotated.width().saturating_sub(off_x).max(1));
        let fch = ch.min(rotated.height().saturating_sub(off_y).max(1));
        rotated.crop_imm(off_x, off_y, fcw, fch)
    };

    Ok(trim_near_white_border(&figure))
}

pub fn crop_figures_batch(pdfium: &Pdfium, jobs: &[CropJob]) -> Vec<CropResult> {
    use std::collections::HashMap;
    // Render each (pdf, page) at most once and crop every figure on it from the
    // shared high-resolution render. Jobs already arrive grouped by page, but the
    // cache makes the ordering irrelevant.
    let mut cache: HashMap<(String, u32), DynamicImage> = HashMap::new();
    let mut out = Vec::with_capacity(jobs.len());

    for job in jobs {
        let result = (|| -> Result<(u32,u32)> {
            let key = (job.pdf_path.clone(), job.page_number);
            let img = if let Some(i) = cache.get(&key) { i.clone() } else {
                let i = render_page_for_crop(
                    pdfium,
                    &job.pdf_path,
                    job.password.as_deref(),
                    job.page_number,
                    job.render_dpi,
                    job.skew_angle_deg,
                )?;
                cache.insert(key, i.clone());
                i
            };

            let cropped = crop_and_straighten(&img, job.xmin, job.ymin, job.xmax, job.ymax)?;
            if let Some(parent) = Path::new(&job.dest_path).parent() {
                fs::create_dir_all(parent).ok();
            }
            save_jpeg(&cropped, &PathBuf::from(&job.dest_path), FIGURE_JPEG_QUALITY)?;
            Ok((cropped.width(), cropped.height()))
        })();

        out.push(match result {
            Ok((w,h)) => CropResult { job_id: job.job_id.clone(), ok: true, error: None, width: w, height: h },
            Err(e)    => CropResult { job_id: job.job_id.clone(), ok: false, error: Some(format!("{e:#}")), width: 0, height: 0 },
        });
    }
    out
}

pub fn figures_dir_for(app_data: &Path, cache_key: &str) -> PathBuf {
    app_data.join("figures").join(cache_key)
}

pub fn cleanup_figures(app_data: &Path, cache_key: &str) -> Result<()> {
    let dir = figures_dir_for(app_data, cache_key);
    if dir.exists() { fs::remove_dir_all(dir)?; }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_crop_region() {
        use image::{ImageBuffer, Rgb};

        // Create a synthetic image (1000x1000 pixels)
        let img = ImageBuffer::from_fn(1000, 1000, |x, y| {
            if x % 2 == 0 && y % 2 == 0 {
                Rgb([0, 0, 0])
            } else {
                Rgb([255, 255, 255])
            }
        });
        let dynamic_img = DynamicImage::ImageRgb8(img);

        // 1. Valid box (0..1000 scale). Raw box is 400px; with 1.5% padding on
        // each edge it becomes (xmin - 15) .. (xmax + 15) = 430px.
        let valid = crop_region(&dynamic_img, 100, 100, 500, 500).unwrap();
        assert_eq!(valid.width(), 430);
        assert_eq!(valid.height(), 430);

        // 2. Too small box (area < 0.5%)
        let small = crop_region(&dynamic_img, 100, 100, 102, 102);
        assert!(small.is_err());
        assert!(small.unwrap_err().to_string().contains("too small"));

        // 3. Too large box (area > 95%)
        let large = crop_region(&dynamic_img, 0, 0, 1000, 1000);
        assert!(large.is_err());
        assert!(large.unwrap_err().to_string().contains("full page"));
    }

    #[test]
    fn test_trim_near_white_border() {
        use image::{ImageBuffer, Rgb};

        // 200x200 white image with a 100x100 black square inset at (50,50).
        let img = ImageBuffer::from_fn(200, 200, |x, y| {
            if (50..150).contains(&x) && (50..150).contains(&y) {
                Rgb([0, 0, 0])
            } else {
                Rgb([255, 255, 255])
            }
        });
        let trimmed = trim_near_white_border(&DynamicImage::ImageRgb8(img));
        // The 50px white margins should be removed, leaving the 100x100 square.
        assert_eq!(trimmed.width(), 100);
        assert_eq!(trimmed.height(), 100);

        // An all-white image must be left untouched (no degenerate crop).
        let blank = DynamicImage::ImageRgb8(ImageBuffer::from_pixel(100, 100, Rgb([255, 255, 255])));
        let blank_out = trim_near_white_border(&blank);
        assert_eq!(blank_out.width(), 100);
        assert_eq!(blank_out.height(), 100);
    }
}

