// Applies the saved light/dark choice before the page paints (no flash).
// Loaded synchronously in <head>; the toggle button itself lives in app.js.
(function () {
  try {
    var theme = localStorage.getItem("linklab-theme");
    if (theme === "light" || theme === "dark") document.documentElement.setAttribute("data-theme", theme);
  } catch (e) { /* storage unavailable: follow the OS setting */ }
})();
