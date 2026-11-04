/*
 * Tenzen Studio — tabs contract (canonical)
 * version 1.0.0
 *
 * Sliding active plate for plugin panels. Copy this file byte-for-byte into a plugin that uses
 * `<div class="tabs">` and `.tab` buttons; the checker verifies the hash.
 *
 *   <div class="tabs" role="tablist">
 *     <button class="tab active" type="button" role="tab">Generate</button>
 *     <button class="tab" type="button" role="tab">Settings</button>
 *   </div>
 *   <script src="tabs.js"></script>
 *
 * The CSS side (.tabs.has-thumb .tab-thumb, .tabs.is-ready .tab-thumb) lives in panel.css.
 */
(function (root) {
  "use strict";

  const ACTIVE = ["active", "is-active"];

  function isActive(item) {
    return ACTIVE.some((name) => item.classList.contains(name));
  }

  function enhance(tabs) {
    if (!tabs || tabs.dataset.tabsEnhanced === "1") return;
    const items = Array.from(tabs.querySelectorAll(".tab"));
    if (items.length < 2) return;
    tabs.dataset.tabsEnhanced = "1";
    tabs.classList.add("has-thumb");

    const thumb = document.createElement("span");
    thumb.className = "tab-thumb";
    thumb.setAttribute("aria-hidden", "true");
    tabs.prepend(thumb);

    function activeItem() {
      return items.find(isActive) || items[0];
    }

    function place() {
      if (tabs.offsetParent === null) return;
      const active = activeItem();
      // offsetLeft/offsetWidth are relative to the positioned .tabs container and stable across
      // scroll/zoom; the retries below make sure flex/font layout has finished.
      if (!active.offsetWidth) return;
      thumb.style.left = active.offsetLeft + "px";
      thumb.style.width = active.offsetWidth + "px";
      // Add the transition class one frame later so the first placement jumps into place instead of
      // animating from the hidden (0 width) state.
      if (!tabs.classList.contains("is-ready") && !tabs.dataset.readyQueued) {
        tabs.dataset.readyQueued = "1";
        requestAnimationFrame(() => tabs.classList.add("is-ready"));
      }
    }

    let frame = 0;
    function schedule() {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        place();
      });
    }

    for (const item of items) {
      new MutationObserver(schedule).observe(item, { attributes: true, attributeFilter: ["class"] });
    }
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(schedule).observe(tabs);
    // Overlays start hidden (offsetParent null); place the plate when the tabs become visible.
    if (typeof IntersectionObserver !== "undefined") {
      new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) schedule();
      }).observe(tabs);
    }
    window.addEventListener("resize", schedule);
    window.addEventListener("load", schedule);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule).catch(() => {});
    requestAnimationFrame(() => requestAnimationFrame(schedule));
    setTimeout(schedule, 300);
  }

  function enhanceAll(scope) {
    const host = scope || (typeof document !== "undefined" ? document : null);
    if (!host) return 0;
    host.querySelectorAll(".tabs").forEach(enhance);
    return 0;
  }

  root.TenzenTabs = { enhance, enhanceAll, version: "1.0.0" };

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => enhanceAll());
    else enhanceAll();
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
