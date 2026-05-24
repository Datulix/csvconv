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

