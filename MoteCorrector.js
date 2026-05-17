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
#include <pjsr/TextAlign.jsh>
#include <pjsr/UndoFlag.jsh>

// Backward-compat shims for the V8 runtime introduced in PixInsight 1.9.4
// (used by default on the ARM64 macOS native build, which does not ship the
// legacy SpiderMonkey engine). The pjsr/*.jsh headers above are flagged as
// deprecated under V8; if a future release stops processing them, the
// underscore-prefixed constants below would become undefined and the script
// would break. Defining them defensively keeps a single source file
// compatible with both engines. Values match include/pjsr/UndoFlag.jsh and
// include/pjsr/TextAlign.jsh from the PixInsight distribution.
if (typeof UndoFlag_NoSwapFile  === "undefined") var UndoFlag_NoSwapFile  = 0x00010000;
if (typeof TextAlign_Left       === "undefined") var TextAlign_Left       = 0x01;
if (typeof TextAlign_Right      === "undefined") var TextAlign_Right      = 0x02;
if (typeof TextAlign_VertCenter === "undefined") var TextAlign_VertCenter = 0x80;

#define TITLE   "MoteCorrector"
#define VERSION "2.3"

function Params() {
   this.masterId         = "";
   this.masterIsStarless = false;  // if true, skip StarNet2 and use master as starless
   this.feather          = 60;     // mask feather (px)
   this.mltLayers     = 6;        // total MLT detail layers
   this.killLayers    = 4;        // disable layers 1..killLayers
   this.inPlace       = true;     // overwrite master instead of creating new image
   this.cleanStarless = true;     // close auto-generated starless when done
   this.cleanLocalFlat  = true;     // close local_flat_full when done
   this.useExclusions = false;    // enable exclusion previews
   this.exclusionIds  = [];       // preview IDs to treat as exclusion regions
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
   // Feature-detect: StarNet2 is a third-party module and is not bundled with
   // PixInsight. On the 1.9.4 Apple Silicon (ARM) build in particular, users
   // may not yet have a working StarNet2 installation. Fail with an actionable
   // message rather than a generic "StarNet2 is not defined".
   if (typeof StarNet2 == "undefined") {
      throw new Error(
         "StarNet2 process not found. Install the StarNet2 module from " +
         "starnetastro.com, or tick 'Image is already starless' if your " +
         "master is starless already.");
   }

   Console.writeln("Cloning master...");
   var win = cloneToNewWindow(masterView, masterView.id + "_starless");

   Console.writeln("Running StarNet2...");
   var sn = new StarNet2();
   sn.stride = 0;       // Stride_128
   sn.mask   = false;   // produce starless, not a mask
   sn.executeOn(win.mainView);

   win.show();
   return win.mainView;
}

// ----- Dialog ---------------------------------------------------------------

// Populate a Dialog instance with all controls and layout. Engine-agnostic:
// works whether the instance was created via ES6 `class extends Dialog`
// (required on V8 / PI 1.9.4) or via the legacy `__base__` constructor
// pattern (still works on SpiderMonkey / PI 1.8.9 through 1.9.3). The
// instance is passed in as `self` rather than via `this` so the body is
// callable from either inheritance shim below.
function buildCorrectorDialog(self) {
   self.windowTitle = TITLE + " v" + VERSION;
   self.minWidth = 640;

   var LABEL_W = 240;   // wide enough for "MultiscaleLinearTransform layers:"
   var SPIN_W  = 80;

   // ===== Instructions =====
   var helpBox = new GroupBox(self);
   helpBox.title = "How to mark dust motes";
   var helpText = new Label(helpBox);
   helpText.useRichText = true;
   helpText.wordWrapping = true;
   helpText.text =
      "<b>1.</b> Activate the <i>New Preview</i> tool: " +
         "menu <b>Preview &gt; New Preview.</b>" +
      "<br><b>2.</b> On the master image, drag a rectangle around each mote. " +
         "Make it slightly larger than the donut so the rectangle <i>perimeter</i> " +
         "sits on clean sky background." +
      "<br><b>3.</b> One preview per mote. They appear as <code>Preview01</code>, " +
         "<code>Preview02</code>, ... in the right-side preview list." +
      "<br><b>4.</b> Avoid placing the rectangle <i>edge</i> on the galaxy/nebula, " +
         "another mote, or the image border &mdash; the local sky reference is sampled " +
         "from the perimeter." +
      "<br><b>5.</b> If a faint galaxy inside a mote preview causes overcorrection, " +
         "draw a smaller preview around the galaxy &mdash; with its <i>perimeter on " +
         "clean sky</i>, just like a mote rectangle &mdash; then check it in the " +
         "<i>Exclusion regions</i> list below.";
   var helpSizer = new VerticalSizer();
   helpSizer.margin = 8;
   helpSizer.add(helpText);
   helpBox.sizer = helpSizer;

   // ===== Master + preview status =====
   var masterCombo = new ComboBox(self);
   var wins = ImageWindow.windows;
   for (var i = 0; i < wins.length; ++i)
      masterCombo.addItem(wins[i].mainView.id);

   // Fall back to first window only if nothing is set; otherwise keep loaded.
   if (params.masterId == "" && wins.length > 0)
      params.masterId = masterCombo.itemText(0);

   // Select the combo item matching the (loaded or fallback) ID.
   function selectComboItem(combo, id) {
      for (var k = 0; k < combo.numberOfItems; ++k)
         if (combo.itemText(k) == id) { combo.currentItem = k; return; }
   }
   selectComboItem(masterCombo, params.masterId);

   // Preview-count indicator
   var previewStatus = new Label(self);
   previewStatus.useRichText = true;
   previewStatus.minWidth = 200;
   function updatePreviewStatus() {
      // V8 (PI 1.9.4) returns null on lookup miss; SpiderMonkey returns an
      // invalid view object whose .isNull is true. Handle both.
      var v = View.viewById(params.masterId);
      if (v === null || v.isNull) {
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
      rebuildExclusionTree();
   };
   // Refresh button — re-counts previews after user draws them with dialog open
   var refreshBtn = new ToolButton(self);
   refreshBtn.icon = self.scaledResource(":/icons/refresh.png");
   refreshBtn.toolTip = "Refresh preview list after drawing previews on the master";
   refreshBtn.onClick = function() {
      updatePreviewStatus();
      rebuildExclusionTree();
   };

   // Mutually exclusive checkboxes for starless source. Exactly one is always
   // checked: clicking the unchecked one toggles modes; clicking an already-
   // checked one re-asserts it (no-op). This mirrors radio-button semantics
   // while preserving the requested checkbox visuals.
   var alreadyStarlessCheck = new CheckBox(self);
   alreadyStarlessCheck.text = "Image is already starless";
   alreadyStarlessCheck.checked = params.masterIsStarless;
   alreadyStarlessCheck.toolTip = "Skip StarNet2 and use the master itself as the starless source\n" +
                                  "for the local flat. Use this if you pre-ran a starless tool\n" +
                                  "(e.g. StarXTerminator) and want to feed the result directly.";

   var createStarlessCheck = new CheckBox(self);
   createStarlessCheck.text = "Create starless image using StarNet2";
   createStarlessCheck.checked = !params.masterIsStarless;
   createStarlessCheck.toolTip = "Generate a starless copy of the master via StarNet2.\n" +
                                 "Requires the StarNet2 process module to be installed in PixInsight.";

   // Forward-referenced: cleanStarlessCheck is created further down. The
   // closures below run after construction, so the reference resolves fine.
   function syncCleanStarlessEnabled() {
      if (cleanStarlessCheck)
         cleanStarlessCheck.enabled = !params.masterIsStarless;
   }

   alreadyStarlessCheck.onCheck = function(checked) {
      if (checked) {
         params.masterIsStarless = true;
         createStarlessCheck.checked = false;
         syncCleanStarlessEnabled();
      } else {
         alreadyStarlessCheck.checked = true;  // exactly one must stay on
      }
   };
   createStarlessCheck.onCheck = function(checked) {
      if (checked) {
         params.masterIsStarless = false;
         alreadyStarlessCheck.checked = false;
         syncCleanStarlessEnabled();
      } else {
         createStarlessCheck.checked = true;
      }
   };

   // Numeric controls
   var featherSpin = new SpinBox(self);
   featherSpin.setRange(1, 200);
   featherSpin.value = params.feather;
   featherSpin.setFixedWidth(SPIN_W);
   featherSpin.onValueUpdated = function(v) { params.feather = v; };

   var layersSpin = new SpinBox(self);
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

   var killSpin = new SpinBox(self);
   killSpin.setRange(0, 12);
   killSpin.value = params.killLayers;
   killSpin.setFixedWidth(SPIN_W);
   killSpin.toolTip = "Disable the first N detail layers — those carry stars and " +
                      "fine structure that should not contribute to the local flat.";
   killSpin.onValueUpdated = function(v) { params.killLayers = v; };

   // In-place checkbox
   var inPlaceCheck = new CheckBox(self);
   inPlaceCheck.text = "Apply correction in place (overwrite master)";
   inPlaceCheck.checked = params.inPlace;
   inPlaceCheck.toolTip = "If checked, the master image is modified directly.\n" +
                          "If unchecked, a new image '<masterID>_corrected' is created.";
   inPlaceCheck.onCheck = function(checked) { params.inPlace = checked; };

   // Cleanup checkboxes
   var cleanStarlessCheck = new CheckBox(self);
   cleanStarlessCheck.text = "Close auto-generated starless when done";
   cleanStarlessCheck.checked = params.cleanStarless;
   cleanStarlessCheck.toolTip = "Closes the starless image after correction. Only applies " +
                                "when 'Auto-create starless' is on \u2014 a manually supplied " +
                                "starless is never closed.";
   cleanStarlessCheck.onCheck = function(checked) { params.cleanStarless = checked; };
   // Greyed out when "Image is already starless" is on — there is nothing
   // auto-generated to close in that mode.
   cleanStarlessCheck.enabled = !params.masterIsStarless;

   var cleanLocalFlatCheck = new CheckBox(self);
   cleanLocalFlatCheck.text = "Close local_flat_full when done";
   cleanLocalFlatCheck.checked = params.cleanLocalFlat;
   cleanLocalFlatCheck.toolTip = "Closes the local_flat_full intermediate after correction. " +
                               "Uncheck if you want to inspect or reuse it.";
   cleanLocalFlatCheck.onCheck = function(checked) { params.cleanLocalFlat = checked; };

   // Exclusion regions: previews drawn inside a mote rectangle around faint
   // galaxies/nebulae left in the starless. The correction is feathered to zero
   // inside these rectangles so a residual bright bump in local_flat_full does
   // not darken the source on division.
   var excludeCheck = new CheckBox(self);
   excludeCheck.text = "Excluded region (only check the box if your first run shows overcorrection around small galaxies)";
   excludeCheck.checked = params.useExclusions;
   excludeCheck.toolTip = "Mark some previews as exclusion regions. The correction is\n" +
                          "feathered out inside them, so faint galaxies left in the\n" +
                          "starless do not cause overcorrection.";

   var exclusionTree = new TreeBox(self);
   exclusionTree.alternateRowColor = true;
   exclusionTree.numberOfColumns = 1;
   exclusionTree.headerVisible = false;
   exclusionTree.rootDecoration = false;
   exclusionTree.toolTip = "Check each preview that should be treated as an exclusion region.";
   exclusionTree.enabled = params.useExclusions;

   function rebuildExclusionTree() {
      exclusionTree.clear();
      var v = View.viewById(params.masterId);
      if (v === null || v.isNull) { fitTreeToFourRows(); return; }
      var pvs = v.window.previews;
      // Drop stale IDs that no longer exist as previews.
      var live = {};
      for (var i = 0; i < pvs.length; ++i) live[pvs[i].id] = true;
      params.exclusionIds = params.exclusionIds.filter(function(id) { return live[id]; });
      for (var i = 0; i < pvs.length; ++i) {
         var node = new TreeBoxNode(exclusionTree);
         var pid = pvs[i].id;
         node.setText(0, pid);
         node.checkable = true;
         node.checked = params.exclusionIds.indexOf(pid) >= 0;
      }
      fitTreeToFourRows();
   }

   // Lock the tree to exactly 4 visible rows. Measures actual row height from
   // the first node when one exists; otherwise uses a conservative font-based
   // estimate. Scrollbar appears automatically beyond 4 rows.
   function fitTreeToFourRows() {
      var rowH;
      if (exclusionTree.numberOfChildren > 0) {
         var rect = exclusionTree.nodeRect(exclusionTree.child(0));
         rowH = rect.y1 - rect.y0;
      } else {
         rowH = exclusionTree.font.lineSpacing + 8;
      }
      // 2*frame + 4 rows + small slack so the 4th row isn't clipped by borders.
      exclusionTree.setFixedHeight(4 * rowH + 8);
   }
   fitTreeToFourRows();

   exclusionTree.onNodeUpdated = function(node, col) {
      var pid = node.text(0);
      var idx = params.exclusionIds.indexOf(pid);
      if (node.checked && idx < 0) params.exclusionIds.push(pid);
      else if (!node.checked && idx >= 0) params.exclusionIds.splice(idx, 1);
   };

   excludeCheck.onCheck = function(checked) {
      params.useExclusions = checked;
      exclusionTree.enabled = checked;
   };

   // Initial population of preview-derived widgets (tree + status label).
   updatePreviewStatus();
   rebuildExclusionTree();

   // Helper to build a labeled row
   function row(text, ctrl) {
      var lbl = new Label(self);
      lbl.text = text;
      lbl.minWidth = LABEL_W;
      lbl.textAlignment = TextAlign_Left | TextAlign_VertCenter;
      var s = new HorizontalSizer(); s.spacing = 8;
      s.add(lbl); s.add(ctrl); s.addStretch();
      return s;
   }

   // Run helper used by the Apply button
   function runCorrection() {
      if (params.masterId == "") {
         Console.criticalln("Pick a master image.");
         return;
      }
      try {
         correctMotes();
         updatePreviewStatus();
         rebuildExclusionTree();
      } catch (e) {
         Console.criticalln("Error: " + e);
      }
   }

   // Buttons: Apply (run, keep open) and Close (dismiss).
   var apply = new PushButton(self);  apply.text  = "Apply";
   var cancel = new PushButton(self); cancel.text = "Close";
   apply.toolTip  = "Run the correction without closing this dialog. " +
                    "Adjust parameters and click Apply again to iterate.";
   cancel.toolTip = "Close the dialog.";
   apply.onClick  = function() { runCorrection(); };
   cancel.onClick = function() { self.cancel(); };
   var btns = new HorizontalSizer(); btns.spacing = 6;
   btns.addStretch();
   btns.add(apply);
   btns.add(cancel);

   // Master row with refresh button + status
   var masterRow = new HorizontalSizer(); masterRow.spacing = 8;
   var masterLbl = new Label(self);
   masterLbl.text = "Master image:";
   masterLbl.minWidth = LABEL_W;
   masterLbl.textAlignment = TextAlign_Left | TextAlign_VertCenter;
   masterRow.add(masterLbl); masterRow.add(masterCombo, 100); masterRow.add(refreshBtn);

   var statusRow = new HorizontalSizer(); statusRow.spacing = 8;
   var statusLbl = new Label(self); statusLbl.text = ""; statusLbl.minWidth = LABEL_W;
   statusRow.add(statusLbl); statusRow.add(previewStatus); statusRow.addStretch();

   // Group: image inputs
   var inputsGroup = new GroupBox(self);
   inputsGroup.title = "Images";
   var inputsSizer = new VerticalSizer(); inputsSizer.margin = 10; inputsSizer.spacing = 8;
   inputsSizer.add(masterRow);
   inputsSizer.add(statusRow);
   inputsSizer.add(createStarlessCheck);
   inputsSizer.add(alreadyStarlessCheck);
   inputsGroup.sizer = inputsSizer;

   // Group: local flat parameters
   var paramsGroup = new GroupBox(self);
   paramsGroup.title = "Correction parameters";
   var paramsSizer = new VerticalSizer(); paramsSizer.margin = 10; paramsSizer.spacing = 8;
   paramsSizer.add(row("Feather (px):",                     featherSpin));
   paramsSizer.add(row("MultiscaleLinearTransform layers:", layersSpin));
   paramsSizer.add(row("Disable first N layers:",           killSpin));
   paramsGroup.sizer = paramsSizer;

   // Group: exclusion regions
   var exclusionGroup = new GroupBox(self);
   exclusionGroup.title = "Exclusion regions";
   var exclusionSizer = new VerticalSizer();
   exclusionSizer.margin = 10; exclusionSizer.spacing = 8;
   exclusionSizer.add(excludeCheck);
   exclusionSizer.add(exclusionTree);
   exclusionGroup.sizer = exclusionSizer;

   // Group: output options
   var outputGroup = new GroupBox(self);
   outputGroup.title = "Output";
   var outputSizer = new VerticalSizer(); outputSizer.margin = 10; outputSizer.spacing = 8;
   outputSizer.add(inPlaceCheck);
   outputSizer.add(cleanStarlessCheck);
   outputSizer.add(cleanLocalFlatCheck);
   outputGroup.sizer = outputSizer;

   // Copyright footer
   var copyright = new Label(self);
   copyright.text = "\u00A9 2026 Yuxuan Wang";
   copyright.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   copyright.styleSheet = "QLabel { color: gray; font-size: 10px; }";

   // Top-level layout
   self.sizer = new VerticalSizer(); self.sizer.margin = 10; self.sizer.spacing = 10;
   self.sizer.add(helpBox);
   self.sizer.add(inputsGroup);
   self.sizer.add(paramsGroup);
   self.sizer.add(exclusionGroup);
   self.sizer.add(outputGroup);
   self.sizer.add(btns);
   self.sizer.addSpacing(4);
   self.sizer.add(copyright);
   self.adjustToContents();
}

// Engine-conditional Dialog subclassing.
//
// V8 (default on PI 1.9.4, mandatory on the ARM64 macOS build): the legacy
// `__base__` pattern silently fails to set up inheritance from Dialog,
// breaking the GUI without any error. Per the V8 Script Porting Guide,
// ES6 `class extends Dialog` is the only way to inherit from a core PJSR
// object under V8.
//
// SpiderMonkey 24 (default on PI 1.8.9 through 1.9.3, plus PI 1.9.4 non-ARM
// in its default mode): does not understand the ES6 `class` keyword at all
// and would parse-error on a source-level class declaration. The legacy
// `__base__` pattern is the standard idiom there.
//
// To keep a single source file on both engines, the class declaration is
// wrapped in an `eval` string. SpiderMonkey parses the string as a plain
// string literal at load time (fine), then throws SyntaxError when it
// actually tries to eval it at run time \u2014 which the catch handles by
// falling back to the constructor-function form.
var CorrectorDialog;
try {
   CorrectorDialog = eval(
      "(class extends Dialog { " +
         "constructor() { super(); buildCorrectorDialog(this); } " +
      "})"
   );
} catch (e) {
   CorrectorDialog = function() {
      this.__base__ = Dialog;
      this.__base__();
      buildCorrectorDialog(this);
   };
   CorrectorDialog.prototype = new Dialog();
}

// ----- Main pipeline --------------------------------------------------------

function correctMotes() {
   var master = View.viewById(params.masterId);
   if (master === null || master.isNull) {
      Console.criticalln("Master image not found: " + params.masterId);
      return;
   }

   var win = master.window;
   var allPreviews = win.previews;
   if (allPreviews.length == 0) {
      Console.criticalln("Draw at least one preview around each mote on the master image.");
      return;
   }

   // Split previews into mote rectangles and exclusion rectangles.
   var previews   = [];   // motes — get corrected
   var exclusions = [];   // exclusion regions — correction feathered to zero inside
   for (var pi = 0; pi < allPreviews.length; ++pi) {
      var pid = allPreviews[pi].id;
      if (params.useExclusions && params.exclusionIds.indexOf(pid) >= 0)
         exclusions.push(allPreviews[pi]);
      else
         previews.push(allPreviews[pi]);
   }
   if (previews.length == 0) {
      Console.criticalln("All previews are marked as exclusions. " +
                         "Leave at least one preview around a mote.");
      return;
   }

   Console.writeln("MoteCorrector: " + previews.length + " mote(s)" +
                   (exclusions.length > 0 ? ", " + exclusions.length + " exclusion(s)" : "") +
                   ", MultiscaleLinearTransform layers=" + params.mltLayers +
                   ", kill first " + params.killLayers +
                   ", feather=" + params.feather + "px");

   // 1. Get / generate starless
   var starless;
   var starlessAutoGenerated = false;
   if (params.masterIsStarless) {
      // Master is already starless — use it directly. No StarNet2, no clone yet
      // (cloneToNewWindow below produces local_flat_full from this view).
      starless = master;
   } else {
      try {
         starless = generateStarless(master);
         starlessAutoGenerated = true;
      } catch (e) {
         Console.criticalln("StarNet2 failed: " + e);
         Console.criticalln("If your master is already starless, tick " +
                            "'Master image is already starless' in the dialog. " +
                            "Otherwise install/configure the StarNet2 module.");
         return;
      }
   }

   // 2. Clone starless → local_flat_full
   var lf = cloneToNewWindow(starless, "local_flat_full");

   // 3. MLT: disable first N detail layers, keep the rest + residual
   var mlt = new MultiscaleLinearTransform();
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

   // Exclusion mask + per-exclusion local flat reference. We sample the local
   // flat (lf) along the perimeter of each exclusion rect — that is the value
   // lf would have at the galaxy's location if the galaxy weren't there. We
   // then substitute this scalar for lf inside the exclusion, so the mote
   // correction applies the same multiplicative lift to the galaxy as it does
   // to the surrounding sky. Result: galaxy is preserved, and its background
   // matches the corrected sky outside the exclusion (no visible patch).
   var exclTerms     = [];   // e_j (feathered indicator)
   var exclWeightedB = [];   // e_j * Be_j
   for (var i = 0; i < exclusions.length; ++i) {
      var er = win.previewRect(exclusions[i]);
      var eRef = localRef(er, Math.round(f / 2));
      var Be = eRef.value;
      var em = "max(0,min(1,min(x()-" + er.x0 + "," + er.x1 + "-x())/" + f + "+1))*" +
               "max(0,min(1,min(y()-" + er.y0 + "," + er.y1 + "-y())/" + f + "+1))";
      exclTerms.push("(" + em + ")");
      exclWeightedB.push("(" + em + ")*" + Be);
      var enote = eRef.validSides == 4 ? ""
                : eRef.validSides == 0 ? " [fallback: global median]"
                : " [" + eRef.validSides + "/4 sides in-bounds]";
      Console.writeln("  exclusion " + (i + 1) + ": " + exclusions[i].id +
                      ", lf perimeter ref = " + Be.toFixed(6) + enote);
   }

   // 5. Apply correction with PixelMath
   //    Bm     = sum(m_i*Bm_i)/max(sum_m,eps)        (mote-perimeter sky in master)
   //    Be     = sum(e_j*Be_j)/max(sum_e,eps)        (exclusion-perimeter sky in lf)
   //    eMask  = min(1, sum_e)                        (feathered exclusion indicator)
   //    lf_eff = lf*(1 - eMask) + Be*eMask            (lf with galaxy bumps replaced)
   //    output = $T * (1 + min(1, sum_m) * (Bm / lf_eff - 1))
   var lfId = lf.mainView.id;  // robust to auto-suffixed IDs
   var lfEff;
   if (exclTerms.length > 0) {
      var sumE  = exclTerms.join("+");
      var sumEB = exclWeightedB.join("+");
      var eMask = "min(1," + sumE + ")";
      var Be    = "(" + sumEB + ")/max(" + sumE + ",1e-10)";
      lfEff = "(" + lfId + "*(1-" + eMask + ")+(" + Be + ")*" + eMask + ")";
   } else {
      lfEff = lfId;
   }
   var expr = "$T*(1+min(1," + sumM + ")*((" + sumMB + ")/max(" + sumM +
              ",1e-10)/" + lfEff + "-1))";
   var pm = new PixelMath();
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
   var dlg = new CorrectorDialog();
   dlg.execute();
}

main();
