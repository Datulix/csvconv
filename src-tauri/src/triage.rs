use anyhow::{Context, Result};
use pdfium_render::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PdfType {
    Digital,
    Scanned,
    Mixed,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PageType {
    Digital,
    Scanned,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct TriagePageInfo {
    pub page_number: u32,
    pub is_blank: bool,
    pub page_type: PageType,
    pub text_density: u32,
    pub skew_angle_deg: f32,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct TriageResult {
    pub pdf_type: PdfType,
    pub pages: Vec<TriagePageInfo>,
}

const DIGITAL_THRESHOLD: u32 = 50;
const BLANK_THRESHOLD: u32 = 5;
const SKEW_THUMBNAIL_WIDTH: u32 = 200;

pub fn triage(pdfium: &Pdfium, pdf_path: &str, password: Option<&str>) -> Result<TriageResult> {
    let doc = pdfium
        .load_pdf_from_file(pdf_path, password)
        .with_context(|| format!("failed to open PDF: {pdf_path}"))?;

    let mut pages_info: Vec<TriagePageInfo> = Vec::new();
    let mut digital_count: u32 = 0;
    let mut scanned_count: u32 = 0;

    for (index, page) in doc.pages().iter().enumerate() {
        let page_number = (index + 1) as u32;
        let text_density = match page.text() {
            Ok(text) => text.all().chars().count() as u32,
            Err(_) => 0,
        };

        let page_type = if text_density >= DIGITAL_THRESHOLD {
            PageType::Digital
        } else {
            PageType::Scanned
        };
        match page_type {
            PageType::Digital => digital_count += 1,
            PageType::Scanned => scanned_count += 1,
        }

        let is_blank = text_density < BLANK_THRESHOLD && is_visually_blank(&page).unwrap_or(false);

        let skew_angle_deg = if matches!(page_type, PageType::Scanned) && !is_blank {
            estimate_skew(&page).unwrap_or(0.0)
        } else {
            0.0
        };

        pages_info.push(TriagePageInfo {
            page_number,
            is_blank,
            page_type,
            text_density,
            skew_angle_deg,
        });
    }

    let pdf_type = match (digital_count, scanned_count) {
        (d, 0) if d > 0 => PdfType::Digital,
        (0, s) if s > 0 => PdfType::Scanned,
        _ => PdfType::Mixed,
    };

    Ok(TriageResult {
        pdf_type,
        pages: pages_info,
    })
}

fn is_visually_blank(page: &PdfPage) -> Result<bool> {
    let bitmap = page
        .render_with_config(
            &PdfRenderConfig::new()
                .set_target_width(80)
                .render_form_data(false),
        )
        .context("failed to render thumbnail for blank detection")?;
    let image = bitmap.as_image();
    let gray = image.to_luma8();
    if gray.is_empty() {
        return Ok(true);
    }

    let mut min: u8 = 255;
    let mut max: u8 = 0;
    let mut sum: u64 = 0;
    let mut count: u64 = 0;
    for &p in gray.as_raw() {
        if p < min {
            min = p;
        }
        if p > max {
            max = p;
        }
        sum += p as u64;
        count += 1;
    }
    let range = max.saturating_sub(min);
    let mean = if count > 0 { sum / count } else { 0 };
    Ok(range < 12 && mean > 235)
}

pub(crate) fn estimate_skew(page: &PdfPage) -> Result<f32> {
    let bitmap = page
        .render_with_config(
            &PdfRenderConfig::new()
                .set_target_width(SKEW_THUMBNAIL_WIDTH as Pixels)
                .render_form_data(false),
        )
        .context("failed to render thumbnail for skew detection")?;
    let gray = bitmap.as_image().to_luma8();
    Ok(estimate_skew_luma(&gray, 1))
}

/// Estimate the dominant skew angle (degrees, within ±20°) of a grayscale image
/// from its strongest near-axis edges. Returns 0.0 when fewer than `min_lines`
/// supporting lines are found, which the caller should treat as "don't rotate".
pub(crate) fn estimate_skew_luma(gray: &image::GrayImage, min_lines: usize) -> f32 {
    use imageproc::edges::canny;
    use imageproc::hough::{detect_lines, LineDetectionOptions};

    let edges = canny(gray, 50.0, 100.0);
    let opts = LineDetectionOptions {
        vote_threshold: 60,
        suppression_radius: 6,
    };
    let lines = detect_lines(&edges, opts);

    let mut angles: Vec<f32> = lines
        .iter()
        .map(|l| {
            let mut a = l.angle_in_degrees as f32 - 90.0;
            if a > 45.0 {
                a -= 90.0;
            }
            if a < -45.0 {
                a += 90.0;
            }
            a
        })
        .filter(|a| a.abs() < 20.0)
        .collect();

    if angles.len() < min_lines.max(1) {
        return 0.0;
    }
    angles.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    angles[angles.len() / 2]
}
