// Light, dark or the system's choice, like the app's Settings → General →
// Theme (system by default). Loaded in <head> without defer, so a saved
// choice applies before the first paint; then it wires the header button,
// which steps through System, Light and Dark. The landing page and the docs
// share the choice.
(function () {
  "use strict";
  const KEY = "portplane.theme"; // github.io is shared with other projects
  const THEMES = ["system", "light", "dark"];
  const NAMES = { system: "System", light: "Light", dark: "Dark" };
  const COLORS = { light: "#fdfdfd", dark: "#0c0d0e" };
  const ICONS = {
    system: '<rect x="2.5" y="3.5" width="15" height="10" rx="1.5"/><path d="M7 16.5h6M10 13.5v3"/>',
    light: '<circle cx="10" cy="10" r="3.5"/><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4M14.3 14.3l1.4 1.4M4.3 15.7l1.4-1.4M14.3 5.7l1.4-1.4"/>',
    dark: '<path d="M10 3a5 5 0 0 0 7 7 7 7 0 1 1-7-7z"/>',
  };

  function saved() {
    try {
      const v = localStorage.getItem(KEY);
      return THEMES.includes(v) ? v : "system";
    } catch (e) { return "system"; }
  }

  // data-theme="light|dark" on <html>, none for "system" (style.css).
  function apply(theme) {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
      if (!m.dataset.color) m.dataset.color = m.content;
      m.content = theme === "system" ? m.dataset.color : COLORS[theme];
    });
  }

  function render(btn, theme) {
    const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    btn.innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true">${ICONS[theme]}</svg>`;
    btn.setAttribute("aria-label", `Theme: ${NAMES[theme]}. Switch to ${NAMES[next]}`);
    btn.title = `Theme: ${NAMES[theme]}`;
  }

  apply(saved());
  document.addEventListener("DOMContentLoaded", () => {
    apply(saved()); // the theme-color metas are parsed by now
    document.querySelectorAll(".theme-toggle").forEach((btn) => {
      render(btn, saved());
      btn.addEventListener("click", () => {
        const theme = THEMES[(THEMES.indexOf(saved()) + 1) % THEMES.length];
        try { localStorage.setItem(KEY, theme); } catch (e) { /* storage blocked: this page only */ }
        apply(theme);
        render(btn, theme);
      });
    });
  });
})();
