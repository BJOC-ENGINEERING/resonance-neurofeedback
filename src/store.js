// Local persistence for settings and the saved-protocol library. Raw EEG is never stored.

const SETTINGS_KEY = 'resonance.settings.v2';
const LIBRARY_KEY = 'resonance.protocols.v1';
export const LIBRARY_LIMIT = 24;

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export const loadSettings = () => read(SETTINGS_KEY, {});
export const saveSettings = (settings) => write(SETTINGS_KEY, settings);
export const loadLibrary = () => {
  const list = read(LIBRARY_KEY, []);
  return Array.isArray(list) ? list.slice(0, LIBRARY_LIMIT) : [];
};
export const saveLibrary = (list) => write(LIBRARY_KEY, list.slice(0, LIBRARY_LIMIT));
