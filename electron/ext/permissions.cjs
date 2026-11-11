'use strict';
// macOS permissions Switchboard needs. Accessibility lets it press Return in Grok Bot.
const { systemPreferences, shell } = require('electron');

const ACCESSIBILITY_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
const isMac = process.platform === 'darwin';

function status() {
  return { accessibility: isMac ? systemPreferences.isTrustedAccessibilityClient(false) : true };
}

async function openAccessibility() {
  if (!isMac) return status();
  // Passing true adds Switchboard to the Accessibility list so the user only has to flip it on.
  systemPreferences.isTrustedAccessibilityClient(true);
  await shell.openExternal(ACCESSIBILITY_URL);
  return status();
}

module.exports = {
  handlers: {
    'app:version': () => require('electron').app.getVersion(),
    'perm:status': () => status(),
    'perm:openAccessibility': () => openAccessibility(),
  },
};
