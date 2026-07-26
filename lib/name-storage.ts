const KEY = "pingpong.name";

/** Reads the saved display name; empty string when unset or storage is unavailable. */
export function loadName(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveName(name: string): void {
  try {
    window.localStorage.setItem(KEY, name);
  } catch {
    // Storage may be unavailable (private mode); the name just won't persist.
  }
}
