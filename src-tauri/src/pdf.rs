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

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct RasterizedPage {
    pub page_number: u32,
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub deskewed: bool,
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

        let deskewed = if deskew_set.contains(&page_number) {
            let angle = skew_angles
                .iter()
                .find(|(pn, _)| *pn == page_number)
                .map(|(_, a)| *a)
                .unwrap_or(0.0);
            if angle.abs() >= 1.0 {
                image = deskew_image(&image, angle);
                true
            } else {
                false
            }
        } else {
            false
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
            skipped: false,
        });
    }

    Ok(RasterizeResult {
        staging_dir: staging_dir.to_string_lossy().to_string(),
        pages: pages_out,
    })
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
    pub src_path: String,      // page JPEG in run staging dir
    pub dest_path: String,     // absolute path in figures/<cache_key>/
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
const FIGURE_JPEG_QUALITY: u8 = 90;          // higher quality than page raster

pub fn crop_figures_batch(jobs: &[CropJob]) -> Vec<CropResult> {
    use std::collections::HashMap;
    let mut cache: HashMap<String, DynamicImage> = HashMap::new();
    let mut out = Vec::with_capacity(jobs.len());

    for job in jobs {
        let result = (|| -> Result<(u32,u32)> {
            let img = if let Some(i) = cache.get(&job.src_path) { i.clone() } else {
                let i = image::open(&job.src_path)
                    .with_context(|| format!("open {}", job.src_path))?;
                cache.insert(job.src_path.clone(), i.clone());
                i
            };
            let (w, h) = (img.width() as f32, img.height() as f32);

            // Normalized 0..1000 -> pixels, with padding, clamped
            let pad_x = FIGURE_PADDING_PCT * 1000.0;
            let pad_y = FIGURE_PADDING_PCT * 1000.0;
            let xmin_n = (job.xmin as f32 - pad_x).max(0.0);
            let ymin_n = (job.ymin as f32 - pad_y).max(0.0);
            let xmax_n = (job.xmax as f32 + pad_x).min(1000.0);
            let ymax_n = (job.ymax as f32 + pad_y).min(1000.0);

            let x = (xmin_n / 1000.0 * w).round() as u32;
            let y = (ymin_n / 1000.0 * h).round() as u32;
            let cw = (((xmax_n - xmin_n) / 1000.0) * w).round() as u32;
            let ch = (((ymax_n - ymin_n) / 1000.0) * h).round() as u32;

            let area_frac = (cw as f32 * ch as f32) / (w * h);
            if area_frac < MIN_AREA_FRAC { anyhow::bail!("box too small ({:.3}%)", area_frac*100.0); }
            if area_frac > MAX_AREA_FRAC { anyhow::bail!("box covers full page ({:.1}%)", area_frac*100.0); }

            let cw = cw.max(1).min(img.width().saturating_sub(x).max(1));
            let ch = ch.max(1).min(img.height().saturating_sub(y).max(1));

            let cropped = img.crop_imm(x, y, cw, ch);
            if let Some(parent) = Path::new(&job.dest_path).parent() {
                fs::create_dir_all(parent).ok();
            }
            save_jpeg(&cropped, &PathBuf::from(&job.dest_path), FIGURE_JPEG_QUALITY)?;
            Ok((cw, ch))
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
    fn test_crop_figures_batch() {
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

        let temp_dir = std::env::temp_dir().join("csvconv_test");
        fs::create_dir_all(&temp_dir).unwrap();
        let src_path = temp_dir.join("src.jpg");
        save_jpeg(&dynamic_img, &src_path, 82).unwrap();

        // 1. Valid job (bounds on 0..1000 scale)
        let dest_path_valid = temp_dir.join("dest_valid.jpg");
        let job_valid = CropJob {
            job_id: "valid".to_string(),
            src_path: src_path.to_string_lossy().to_string(),
            dest_path: dest_path_valid.to_string_lossy().to_string(),
            ymin: 100,
            xmin: 100,
            ymax: 500,
            xmax: 500,
        };

        // 2. Too small job (area < 0.5%)
        let dest_path_small = temp_dir.join("dest_small.jpg");
        let job_small = CropJob {
            job_id: "small".to_string(),
            src_path: src_path.to_string_lossy().to_string(),
            dest_path: dest_path_small.to_string_lossy().to_string(),
            ymin: 100,
            xmin: 100,
            ymax: 102,
            xmax: 102,
        };

        // 3. Too large job (area > 95%)
        let dest_path_large = temp_dir.join("dest_large.jpg");
        let job_large = CropJob {
            job_id: "large".to_string(),
            src_path: src_path.to_string_lossy().to_string(),
            dest_path: dest_path_large.to_string_lossy().to_string(),
            ymin: 0,
            xmin: 0,
            ymax: 1000,
            xmax: 1000,
        };

        let results = crop_figures_batch(&[job_valid, job_small, job_large]);
        assert_eq!(results.len(), 3);

        // Assert valid job succeeded
        assert!(results[0].ok);
        assert!(dest_path_valid.exists());
        // Padding should make the crop larger than raw box width/height
        // Raw box: (500 - 100) / 1000 * 1000 = 400px. With 1.5% padding on each edge, it is (xmin - 15) and (xmax + 15), so 430px.
        assert_eq!(results[0].width, 430);
        assert_eq!(results[0].height, 430);

        // Assert small job failed
        assert!(!results[1].ok);
        assert!(results[1].error.as_ref().unwrap().contains("too small"));

        // Assert large job failed
        assert!(!results[2].ok);
        assert!(results[2].error.as_ref().unwrap().contains("full page"));

        fs::remove_dir_all(&temp_dir).ok();
    }
}

