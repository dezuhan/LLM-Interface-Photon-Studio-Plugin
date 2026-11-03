"use strict";

// Custom dropdowns matching the Tenzen Studio Design System list designs:
//   node 87:85  "List items"            (rows: 24px, radius 4, selected radius 7 + #dedede)
//   node 88:205 "List items scroll style" (thin 3px scrollbar, thumb #2b2b2b, radius 26)
//
// The native <select> stays in the DOM (visually hidden) so app.js keeps reading/writing
// `select.value`; this module renders the popup and mirrors the selection both ways.

(function () {
  function enhance(select) {
    const wrap = select.closest(".select");
    if (!wrap || wrap.dataset.enhanced === "1") return;
    wrap.dataset.enhanced = "1";

    select.classList.add("select-native");
    select.setAttribute("tabindex", "-1");
    select.setAttribute("aria-hidden", "true");

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "select-trigger";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    const valueSpan = document.createElement("span");
    valueSpan.className = "select-value";
    trigger.append(valueSpan);

    const popup = document.createElement("div");
    popup.className = "select-popup";
    popup.setAttribute("role", "listbox");
    popup.hidden = true;

    wrap.append(trigger, popup);

    function sync() {
      const option = select.options[select.selectedIndex];
      valueSpan.textContent = option ? option.textContent : "";
      trigger.disabled = select.disabled;
      trigger.title = option ? option.textContent : "";
    }
    select._syncCustomSelect = sync;

    function build() {
      popup.textContent = "";
      for (const option of Array.from(select.options)) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "select-item";
        item.setAttribute("role", "option");
        item.textContent = option.textContent;
        item.dataset.value = option.value;
        if (option.value === select.value) {
          item.classList.add("is-selected");
          item.setAttribute("aria-selected", "true");
        }
        item.addEventListener("click", (event) => {
          event.stopPropagation();
          choose(option.value);
        });
        popup.append(item);
      }
    }

    function outside(event) {
      if (!wrap.contains(event.target)) close();
    }

    function open() {
      build();
      popup.hidden = false;
      wrap.classList.add("is-open");
      trigger.setAttribute("aria-expanded", "true");
      document.addEventListener("pointerdown", outside, true);
      const selected = popup.querySelector(".is-selected");
      if (selected) selected.scrollIntoView({ block: "nearest" });
    }

    function close() {
      popup.hidden = true;
      wrap.classList.remove("is-open");
      trigger.setAttribute("aria-expanded", "false");
      document.removeEventListener("pointerdown", outside, true);
    }

    function choose(value) {
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      sync();
      close();
      trigger.focus();
    }

    trigger.addEventListener("click", () => (popup.hidden ? open() : close()));
    trigger.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (popup.hidden) open();
      } else if (event.key === "Escape") {
        close();
      }
    });
    select.addEventListener("change", sync);
    sync();
  }

  function syncAll() {
    document.querySelectorAll("select").forEach((select) => select._syncCustomSelect?.());
  }

  window.syncCustomSelects = syncAll;

  function init() {
    document.querySelectorAll("select").forEach(enhance);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    document.querySelectorAll(".select.is-open .select-trigger").forEach((trigger) => trigger.click());
  });
})();
