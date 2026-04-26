// MoteCorrector — PixInsight script for post-stacking dust-mote correction.
//
// Copyright (c) 2026 Yuxuan Wang
// Released under the MIT License.
// https://github.com/yuxuanwang2009/MoteCorrector
//
// Workflow: open master, draw a preview rectangle around each mote, run script.
// Builds a low-frequency local flat from a starless copy and divides it
// into the master under a feathered, locally-normalized mask per mote.

#feature-id    Utilities > MoteCorrector
#feature-info  Corrects flat-calibration dust motes using a starless image and \
               previews drawn around each mote. Optionally generates the starless \
               internally via StarNet2. \
               Workflow: open master, draw a preview around each mote, run script.

#include <pjsr/Sizer.jsh>
#include <pjsr/StdButton.jsh>
#include <pjsr/TextAlign.jsh>
#include <pjsr/UndoFlag.jsh>

#define TITLE   "MoteCorrector"
#define VERSION "2.0"

function Params() {
   this.masterId      = "";
   this.starlessId    = "";
   this.autoStarless  = true;     // create starless via StarNet2 internally
   this.feather       = 60;       // mask feather (px)
   this.mltLayers     = 6;        // total MLT detail layers
   this.killLayers    = 4;        // disable layers 1..killLayers
   this.inPlace       = true;     // overwrite master instead of creating new image
   this.cleanStarless = true;     // close auto-generated starless when done
   this.cleanLocalFlat  = true;     // close local_flat_full when done
}
var params = new Params();

// ----- Helpers --------------------------------------------------------------

function cloneToNewWindow(srcView, newId) {
   var img = srcView.image;
   var win = new ImageWindow(
      img.width, img.height, img.numberOfChannels,
      32, true, img.colorSpace != 0, newId
   );
   win.mainView.beginProcess(UndoFlag_NoSwapFile);
   win.mainView.image.assign(img);
   win.mainView.endProcess();
   return win;
}

function generateStarless(masterView) {
   Console.writeln("Cloning master...");
   var win = cloneToNewWindow(masterView, masterView.id + "_starless");

   Console.writeln("Running StarNet2...");
   var sn = new StarNet2;
   sn.stride = 0;       // Stride_128
   sn.mask   = false;   // produce starless, not a mask
   sn.executeOn(win.mainView);

   win.show();
   return win.mainView;
}

// ----- Dialog ---------------------------------------------------------------

function CorrectorDialog() {
   this.__base__ = Dialog;
   this.__base__();
   var self = this;
   this.windowTitle = TITLE + " v" + VERSION;
   this.minWidth = 640;

   var LABEL_W = 240;   // wide enough for "MultiscaleLinearTransform layers:"
   var SPIN_W  = 80;

   // ===== Instructions =====
   var helpBox = new GroupBox(this);
   helpBox.title = "How to mark dust motes";
   var helpText = new Label(helpBox);
   helpText.useRichText = true;
   helpText.wordWrapping = true;
   helpText.text =
      "<b>1.</b> Activate the <i>New Preview</i> tool: " +
         "menu <b>Preview &gt; New Preview.</b>" +
      "<br><b>2.</b> On the master image, drag a rectangle around each mote. " +
         "Make it generously larger than the donut so the rectangle <i>perimeter</i> " +
         "sits on clean sky background." +
      "<br><b>3.</b> One preview per mote. They appear as <code>Preview01</code>, " +
         "<code>Preview02</code>, ... in the right-side preview list." +
      "<br><b>4.</b> Avoid placing the rectangle <i>edge</i> on the galaxy/nebula, " +
         "another mote, or the image border &mdash; the local sky reference is sampled " +
         "from the perimeter.";
   var helpSizer = new VerticalSizer;
   helpSizer.margin = 8;
   helpSizer.add(helpText);
   helpBox.sizer = helpSizer;

   // ===== Master + preview status =====
   var masterCombo   = new ComboBox(this);
   var starlessCombo = new ComboBox(this);
   var wins = ImageWindow.windows;
   for (var i = 0; i < wins.length; ++i) {
      masterCombo.addItem(wins[i].mainView.id);
      starlessCombo.addItem(wins[i].mainView.id);
   }

   // Fall back to first window only if nothing is set; otherwise keep loaded.
   if (params.masterId == "" && wins.length > 0)
      params.masterId = masterCombo.itemText(0);
   if (params.starlessId == "" && wins.length > 0)
      params.starlessId = starlessCombo.itemText(0);

   // Select the combo item matching the (loaded or fallback) ID.
   function selectComboItem(combo, id) {
      for (var k = 0; k < combo.numberOfItems; ++k)
         if (combo.itemText(k) == id) { combo.currentItem = k; return; }
   }
   selectComboItem(masterCombo,   params.masterId);
   selectComboItem(starlessCombo, params.starlessId);

   // Preview-count indicator
   var previewStatus = new Label(this);
   previewStatus.useRichText = true;
   previewStatus.minWidth = 200;
   function updatePreviewStatus() {
      var v = View.viewById(params.masterId);
      if (v.isNull) {
         previewStatus.text = "<i>(select a master)</i>";
         return;
      }
      var n = v.window.previews.length;
      if (n == 0)
         previewStatus.text = "<font color='#cc4444'><b>0 previews</b> &mdash; draw rectangles around motes</font>";
      else
         previewStatus.text = "<font color='#44aa44'><b>" + n + " preview" + (n == 1 ? "" : "s") + "</b> detected</font>";
   }

   masterCombo.onItemSelected = function(i) {
      params.masterId = masterCombo.itemText(i);
      updatePreviewStatus();
   };
   starlessCombo.onItemSelected = function(i) { params.starlessId = starlessCombo.itemText(i); };

   // Refresh button — re-counts previews after user draws them with dialog open
   var refreshBtn = new ToolButton(this);
   refreshBtn.icon = self.scaledResource(":/icons/refresh.png");
   refreshBtn.toolTip = "Refresh preview count after drawing previews on the master";
   refreshBtn.onClick = function() { updatePreviewStatus(); };

   updatePreviewStatus();

   // Auto-starless checkbox
   var autoCheck = new CheckBox(this);
   autoCheck.text = "Auto-create starless via StarNet2";
   autoCheck.checked = params.autoStarless;
   autoCheck.toolTip = "If checked, a starless copy of the master is generated automatically.\n" +
                       "Requires the StarNet2 process module to be installed in PixInsight.";
   autoCheck.onCheck = function(checked) {
      params.autoStarless = checked;
      starlessCombo.enabled = !checked;
   };
   starlessCombo.enabled = !params.autoStarless;

   // Numeric controls
   var featherSpin = new SpinBox(this);
   featherSpin.setRange(1, 200);
   featherSpin.value = params.feather;
   featherSpin.setFixedWidth(SPIN_W);
   featherSpin.onValueUpdated = function(v) { params.feather = v; };

   var layersSpin = new SpinBox(this);
   layersSpin.setRange(2, 12);
   layersSpin.value = params.mltLayers;
   layersSpin.setFixedWidth(SPIN_W);
   layersSpin.toolTip = "Total number of wavelet detail layers.";
   layersSpin.onValueUpdated = function(v) {
      params.mltLayers = v;
      if (params.killLayers > v) {
         params.killLayers = v;
         killSpin.value = v;
      }
   };

   var killSpin = new SpinBox(this);
   killSpin.setRange(0, 12);
   killSpin.value = params.killLayers;
   killSpin.setFixedWidth(SPIN_W);
   killSpin.toolTip = "Disable the first N detail layers — those carry stars and " +
                      "fine structure that should not contribute to the local flat.";
   killSpin.onValueUpdated = function(v) { params.killLayers = v; };

   // In-place checkbox
   var inPlaceCheck = new CheckBox(this);
   inPlaceCheck.text = "Apply correction in place (overwrite master)";
   inPlaceCheck.checked = params.inPlace;
   inPlaceCheck.toolTip = "If checked, the master image is modified directly.\n" +
                          "If unchecked, a new image '<masterID>_corrected' is created.";
   inPlaceCheck.onCheck = function(checked) { params.inPlace = checked; };

   // Cleanup checkboxes
   var cleanStarlessCheck = new CheckBox(this);
   cleanStarlessCheck.text = "Close auto-generated starless when done";
   cleanStarlessCheck.checked = params.cleanStarless;
   cleanStarlessCheck.toolTip = "Closes the starless image after correction. Only applies " +
                                "when 'Auto-create starless' is on \u2014 a manually supplied " +
                                "starless is never closed.";
   cleanStarlessCheck.onCheck = function(checked) { params.cleanStarless = checked; };

   var cleanLocalFlatCheck = new CheckBox(this);
   cleanLocalFlatCheck.text = "Close local_flat_full when done";
   cleanLocalFlatCheck.checked = params.cleanLocalFlat;
   cleanLocalFlatCheck.toolTip = "Closes the local_flat_full intermediate after correction. " +
                               "Uncheck if you want to inspect or reuse it.";
   cleanLocalFlatCheck.onCheck = function(checked) { params.cleanLocalFlat = checked; };

   // Helper to build a labeled row
   function row(text, ctrl) {
      var lbl = new Label(self);
      lbl.text = text;
      lbl.minWidth = LABEL_W;
      lbl.textAlignment = TextAlign_Left | TextAlign_VertCenter;
      var s = new HorizontalSizer; s.spacing = 8;
      s.add(lbl); s.add(ctrl); s.addStretch();
      return s;
   }

   // Run helper used by the Apply button
   function runCorrection() {
      if (params.masterId == "") {
         Console.criticalln("Pick a master image.");
         return;
      }
      if (!params.autoStarless && params.starlessId == "") {
         Console.criticalln("Pick a starless image, or enable auto-create.");
         return;
      }
      try {
         correctMotes();
         updatePreviewStatus();
      } catch (e) {
         Console.criticalln("Error: " + e);
      }
   }

   // Buttons: Apply (run, keep open) and Close (dismiss).
   var apply = new PushButton(this);  apply.text  = "Apply";
   var cancel = new PushButton(this); cancel.text = "Close";
   apply.toolTip  = "Run the correction without closing this dialog. " +
                    "Adjust parameters and click Apply again to iterate.";
   cancel.toolTip = "Close the dialog.";
   apply.onClick  = function() { runCorrection(); };
   cancel.onClick = function() { self.cancel(); };
   var btns = new HorizontalSizer; btns.spacing = 6;
   btns.addStretch();
   btns.add(apply);
   btns.add(cancel);

   // Master row with refresh button + status
   var masterRow = new HorizontalSizer; masterRow.spacing = 8;
   var masterLbl = new Label(this);
   masterLbl.text = "Master image:";
   masterLbl.minWidth = LABEL_W;
   masterLbl.textAlignment = TextAlign_Left | TextAlign_VertCenter;
   masterRow.add(masterLbl); masterRow.add(masterCombo, 100); masterRow.add(refreshBtn);

   var statusRow = new HorizontalSizer; statusRow.spacing = 8;
   var statusLbl = new Label(this); statusLbl.text = ""; statusLbl.minWidth = LABEL_W;
   statusRow.add(statusLbl); statusRow.add(previewStatus); statusRow.addStretch();

   // Group: image inputs
   var inputsGroup = new GroupBox(this);
   inputsGroup.title = "Images";
   var inputsSizer = new VerticalSizer; inputsSizer.margin = 10; inputsSizer.spacing = 8;
   inputsSizer.add(masterRow);
   inputsSizer.add(statusRow);
   inputsSizer.add(autoCheck);
   inputsSizer.add(row("Starless image:", starlessCombo));
   inputsGroup.sizer = inputsSizer;

   // Group: local flat parameters
   var paramsGroup = new GroupBox(this);
   paramsGroup.title = "Correction parameters";
   var paramsSizer = new VerticalSizer; paramsSizer.margin = 10; paramsSizer.spacing = 8;
   paramsSizer.add(row("Feather (px):",                     featherSpin));
   paramsSizer.add(row("MultiscaleLinearTransform layers:", layersSpin));
   paramsSizer.add(row("Disable first N layers:",           killSpin));
   paramsGroup.sizer = paramsSizer;

   // Group: output options
   var outputGroup = new GroupBox(this);
   outputGroup.title = "Output";
   var outputSizer = new VerticalSizer; outputSizer.margin = 10; outputSizer.spacing = 8;
   outputSizer.add(inPlaceCheck);
   outputSizer.add(cleanStarlessCheck);
   outputSizer.add(cleanLocalFlatCheck);
   outputGroup.sizer = outputSizer;

   // Copyright footer
   var copyright = new Label(this);
   copyright.text = "\u00A9 2026 Yuxuan Wang";
   copyright.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   copyright.styleSheet = "QLabel { color: gray; font-size: 10px; }";

   // Top-level layout
   this.sizer = new VerticalSizer; this.sizer.margin = 10; this.sizer.spacing = 10;
   this.sizer.add(helpBox);
   this.sizer.add(inputsGroup);
   this.sizer.add(paramsGroup);
   this.sizer.add(outputGroup);
   this.sizer.add(btns);
   this.sizer.addSpacing(4);
   this.sizer.add(copyright);
   this.adjustToContents();
}
CorrectorDialog.prototype = new Dialog;

// ----- Main pipeline --------------------------------------------------------

function correctMotes() {
   var master = View.viewById(params.masterId);
   if (master.isNull) {
      Console.criticalln("Master image not found: " + params.masterId);
      return;
   }

   var win = master.window;
   var previews = win.previews;
   if (previews.length == 0) {
      Console.criticalln("Draw at least one preview around each mote on the master image.");
      return;
   }

   Console.writeln("MoteCorrector: " + previews.length + " mote(s), " +
                   "MultiscaleLinearTransform layers=" + params.mltLayers +
                   ", kill first " + params.killLayers +
                   ", feather=" + params.feather + "px");

   // 1. Get / generate starless
   var starless;
   var starlessAutoGenerated = false;
   if (params.autoStarless) {
      try {
         starless = generateStarless(master);
         starlessAutoGenerated = true;
      } catch (e) {
         Console.criticalln("StarNet2 failed: " + e);
         Console.criticalln("Either install/configure the StarNet2 module, or uncheck " +
                            "'Auto-create starless' and provide a pre-made starless image.");
         return;
      }
   } else {
      starless = View.viewById(params.starlessId);
      if (starless.isNull) {
         Console.criticalln("Starless image not found: " + params.starlessId);
         return;
      }
      if (starless.id == master.id) {
         Console.criticalln("Master and starless must be different images.");
         return;
      }
   }

   // 2. Clone starless → local_flat_full
   var lf = cloneToNewWindow(starless, "local_flat_full");

   // 3. MLT: disable first N detail layers, keep the rest + residual
   var mlt = new MultiscaleLinearTransform;
   mlt.numberOfLayers = params.mltLayers;
   var L = [];
   for (var i = 0; i < params.mltLayers; ++i) {
      var enabled = (i >= params.killLayers);
      L.push([enabled, true, 0.000, false, 3.000, 1.00, 1]);
   }
   L.push([true, true, 0.000, false, 3.000, 1.00, 1]); // residual always on
   mlt.layers = L;
   mlt.executeOn(lf.mainView);
   lf.show();

   // 4. For each preview, compute a local background reference from local flat
   //    by sampling its perimeter just outside the rectangle. This anchors
   //    the correction to the local sky level near the mote rather than
   //    the global median, which avoids brightness drift over gradients.
   var f = params.feather;
   var lfImg = lf.mainView.image;
   var W = lfImg.width, H = lfImg.height;

   // Sample local flat along the four sides of (rect expanded by `off` pixels).
   // Skip any side that is off-image. Returns { value, validSides }.
   function localRef(rect, off) {
      var nPts = 7;  // sample points per side
      var samples = [];
      var validSides = 0;

      // Helper: sample N points along a horizontal line at y, x from xa to xb
      function sampleHoriz(y, xa, xb) {
         if (y < 0 || y >= H) return false;
         var got = false;
         for (var i = 0; i < nPts; ++i) {
            var x = Math.round(xa + (xb - xa) * i / (nPts - 1));
            if (x >= 0 && x < W) { samples.push(lfImg.sample(x, y, 0)); got = true; }
         }
         return got;
      }
      // Helper: sample N points along a vertical line at x, y from ya to yb
      function sampleVert(x, ya, yb) {
         if (x < 0 || x >= W) return false;
         var got = false;
         for (var i = 0; i < nPts; ++i) {
            var y = Math.round(ya + (yb - ya) * i / (nPts - 1));
            if (y >= 0 && y < H) { samples.push(lfImg.sample(x, y, 0)); got = true; }
         }
         return got;
      }

      if (sampleHoriz(rect.y0 - off, rect.x0, rect.x1)) ++validSides; // top
      if (sampleHoriz(rect.y1 + off, rect.x0, rect.x1)) ++validSides; // bottom
      if (sampleVert (rect.x0 - off, rect.y0, rect.y1)) ++validSides; // left
      if (sampleVert (rect.x1 + off, rect.y0, rect.y1)) ++validSides; // right

      if (samples.length == 0)
         return { value: lfImg.median(), validSides: 0 };  // fallback

      samples.sort(function(a, b) { return a - b; });
      var med = (samples.length % 2)
         ? samples[(samples.length - 1) / 2]
         : 0.5 * (samples[samples.length / 2 - 1] + samples[samples.length / 2]);
      return { value: med, validSides: validSides };
   }

   var maskTerms  = [];   // m_i
   var weightedB  = [];   // m_i * B_i
   for (var i = 0; i < previews.length; ++i) {
      var r = win.previewRect(previews[i]);
      var ref = localRef(r, Math.round(f / 2));
      var B = ref.value;
      var m = "max(0,min(1,min(x()-" + r.x0 + "," + r.x1 + "-x())/" + f + "+1))*" +
              "max(0,min(1,min(y()-" + r.y0 + "," + r.y1 + "-y())/" + f + "+1))";
      maskTerms.push("(" + m + ")");
      weightedB.push("(" + m + ")*" + B);
      var note = ref.validSides == 4 ? ""
               : ref.validSides == 0 ? " [fallback: global median]"
               : " [" + ref.validSides + "/4 sides in-bounds]";
      Console.writeln("  mote " + (i + 1) + ": local ref = " + B.toFixed(6) + note);
   }
   var sumM  = maskTerms.join("+");
   var sumMB = weightedB.join("+");

   // 5. Apply correction with PixelMath
   //    output = $T * (1 + min(1, sum_m) * (sum(m_i*B_i)/max(sum_m,eps)/<local_flat_full> - 1))
   //    Per-mote local B; in overlap regions, weighted-averaged.
   var lfId = lf.mainView.id;  // robust to auto-suffixed IDs
   var expr = "$T*(1+min(1," + sumM + ")*((" + sumMB + ")/max(" + sumM +
              ",1e-10)/" + lfId + "-1))";
   var pm = new PixelMath;
   pm.expression = expr;
   pm.useSingleExpression = true;
   pm.createNewImage      = !params.inPlace;
   pm.newImageId          = params.inPlace ? "" : params.masterId + "_corrected";
   pm.rescaleResult       = false;
   pm.executeOn(master);

   Console.writeln("Done: " + (params.inPlace ? params.masterId + " (in place)"
                                               : pm.newImageId));

   // 6. Optional cleanup of intermediates
   if (params.cleanLocalFlat) {
      try {
         lf.forceClose();
         Console.writeln("Closed: " + lfId);
      } catch (e) {
         Console.warningln("Could not close local flat: " + e);
      }
   }
   if (params.cleanStarless && starlessAutoGenerated) {
      try {
         starless.window.forceClose();
         Console.writeln("Closed: auto-generated starless");
      } catch (e) {
         Console.warningln("Could not close starless: " + e);
      }
   }
}

function main() {
   Console.show();
   var dlg = new CorrectorDialog;
   dlg.execute();
}

main();
