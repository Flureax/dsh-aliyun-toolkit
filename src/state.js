/**
 * Small in-memory snapshot of settings needed synchronously (the prompt
 * section's text provider cannot await). It is refreshed on plugin
 * activation, after every settings save and on every tool call.
 */
let preferences = ''

export function preferencesText() {
  return preferences
}

export function setPreferencesText(value) {
  preferences = typeof value === 'string' ? value : ''
}
