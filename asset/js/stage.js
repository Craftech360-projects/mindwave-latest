/* Scale the fixed stage to whatever panel it is shown on.

   The six screens are drawn at exactly 834x1194 (tablet) or 1920x1080 (wall).
   Rather than make the layout fluid, which would move every coordinate away
   from the one Figma measured, the whole stage is scaled by a single factor and
   letterboxed. At 1:1 the factor is 1 and nothing is resampled. */
(function () {
  function fit() {
    var stage = document.querySelector(".stage");
    if (!stage) return;
    var w = stage.offsetWidth;
    var h = stage.offsetHeight;
    var s = Math.min(window.innerWidth / w, window.innerHeight / h);
    stage.style.transform = s === 1 ? "none" : "scale(" + s + ")";
  }
  window.addEventListener("resize", fit);
  window.addEventListener("orientationchange", fit);
  document.addEventListener("DOMContentLoaded", fit);
  fit();
})();
