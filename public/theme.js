(() => {
  const $ = (id) => document.getElementById(id);
  const themeKey = "mcp-starter-theme";
  const sunIcon =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  const moonIcon =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.6 6.6 0 0 0 9.8 9.8z"/></svg>';
  const currentTheme = () => document.documentElement.dataset.theme || "dark";
  function renderTheme() {
    const dark = currentTheme() === "dark";
    $("theme-toggle").setAttribute(
      "aria-label",
      dark ? "Switch to light theme" : "Switch to dark theme",
    );
    $("theme-toggle").innerHTML = dark ? sunIcon : moonIcon;
  }
  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    renderTheme();
  }
  try {
    const stored = localStorage.getItem(themeKey);
    if (stored === "light" || stored === "dark") setTheme(stored);
    else setTheme("dark");
  } catch {
    setTheme("dark");
  }
  $("theme-toggle").addEventListener("click", () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    setTheme(next);
    try {
      localStorage.setItem(themeKey, next);
    } catch {}
  });
})();
