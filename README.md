# MoteCorrector

A PixInsight script for removing **flat-calibration dust motes** from a stacked
master image, after the fact, without re-shooting flats.

If your master light shows faint donut-shaped shadows that calibration didn't
clean up, MoteCorrector lets you draw a rectangle around each mote and divides
out a locally-anchored synthetic flat. The correction is feathered into the
surrounding sky so it leaves no visible seam.

![MoteCorrector dialog](screenshots/dialog.png)

---

## How it works

1. Generate (or supply) a **starless** copy of the master.
2. Run `MultiscaleLinearTransform` on the starless with the first *N* detail
   layers disabled. This kills stars and small structure, keeping the
   low-frequency illumination — your synthetic flat (`synflat_full`).
3. For each user-drawn preview, sample the local sky from `synflat_full` along
   the **rectangle perimeter** (not the global median). This anchors each
   correction to the local sky level near the mote, which keeps the brightness
   from drifting under a gradient.
4. Apply per-mote correction in PixelMath under a feathered mask:

   $$\text{out} = \text{master}\cdot
   \left(1 + m\cdot\left(\frac{B}{\text{synflat}} - 1\right)\right)$$

   where $m \in [0,1]$ is the feathered preview mask and $B$ is the local sky
   reference for that preview. Overlapping previews are weighted-averaged.

The result is identical to a hand-crafted "flat retouch" PixelMath workflow,
but localized and automated across many motes.

---

## Requirements

- **PixInsight 1.8.9** or later.
- **StarNet2** module — only required if you let MoteCorrector generate the
  starless image automatically. You can also supply your own starless and
  uncheck "Auto-create starless via StarNet2".

---

## Installation

1. Download `MoteCorrector.js` from this repository.
2. In PixInsight: `Script → Feature Scripts… → Add` and select the folder
   containing `MoteCorrector.js`.
3. The script appears under `Script → Utilities → MoteCorrector`.

Alternatively, copy `MoteCorrector.js` into your PixInsight scripts directory
(e.g. `<PI install>/src/scripts/`) and restart PixInsight.

---

## Usage

1. Open your stacked master in PixInsight.
2. Activate the New Preview tool: **Preview → New Preview**.
3. Drag a rectangle around each dust mote. The rectangle should be **larger
   than the donut**, with its perimeter on clean sky background.
   - Avoid placing the rectangle edge on the galaxy/nebula, another mote, or
     the image border.
4. Run `Script → Utilities → MoteCorrector`.
5. Select the master image. The script counts your previews and warns if
   none are drawn.
6. Click **Apply**. Iterate parameters and apply again as needed.

### Parameters

| Parameter | Default | Notes |
|---|---|---|
| Feather (px) | 60 | Half-width of the cosine-feather around each preview rectangle. Larger = softer blend, less localized. |
| MultiscaleLinearTransform layers | 6 | Total wavelet layers. Higher captures larger-scale structure in the synflat. |
| Disable first N layers | 4 | Number of fine-detail layers to disable. Higher = smoother synflat. |
| Apply correction in place | on | If off, creates a new image `<master>_corrected`. |
| Close auto-generated starless | on | Cleanup intermediate when done. |
| Close synflat_full | on | Cleanup intermediate when done. |

### Tips

- The default feather (60 px) and layer settings work for most CDK / RASA-class
  images at native resolution. If your image is heavily binned, drop both.
- One preview per mote. Overlapping previews are blended automatically — fine
  for motes that touch.
- If a mote sits partially off-image or against a bright object, the
  perimeter-based local-sky estimate will degrade gracefully (sampled from
  whatever sides are valid). The console reports `[N/4 sides in-bounds]` for
  diagnostic.

---

## Why not DBE / GraXpert / CloneStamp?

- **DBE / ABE / GraXpert** target large-scale gradients. They will pull
  localized donuts inconsistently, often leaving a halo or shifting global
  brightness.
- **CloneStamp** works for one or two motes but is tedious for a dozen and
  doesn't preserve the underlying sky structure.
- **MoteCorrector** is targeted: rectangle in, donut gone, no global side effects.

---

## License

[MIT](LICENSE) © 2026 Yuxuan Wang.

---

## Changelog

### v2.0
- Local-sky reference sampled from each preview's perimeter (replaces global
  median); correction stays accurate under gradients.
- Auto-generated starless via StarNet2 (optional).
- In-place correction option.
- Spinbox tooltips and dialog spacing improvements.

### v1.0
- Initial release.
