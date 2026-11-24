// Theme preference: "system" | "light" | "dark". Stored in localStorage so index.html
// can apply it before first paint.

export function getTheme() {
  try {
    return localStorage.getItem("theme") ?? "system";
  } catch {
    return "system";
  }
}

export function setTheme(theme) {
  try {
    localStorage.setItem("theme", theme);
  } catch { /* storage blocked: still apply for this session */ }
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}
