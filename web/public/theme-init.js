// Apply the stored override before the app starts. CSS handles the system theme.
(() => {
  try {
    const preference = localStorage.getItem("takos-git:theme");
    if (preference === "light" || preference === "dark") {
      document.documentElement.setAttribute("data-theme", preference);
    }
  } catch {
    // Keep the CSS default when storage is unavailable.
  }
})();
