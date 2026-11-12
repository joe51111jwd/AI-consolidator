'use strict';
// macOS permissions Switchboard needs. Accessibility lets it press Return in Grok Bot. Linux and
// Windows have no such permission (and no Grok Bot app), so there is nothing to ask for there.
const { systemPreferences, shell } = require('electron');

const ACCESSIBILITY_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
const isMac = process.platform === 'darwin';

function status() {
  if (!isMac) return { accessibility: true, applies: false };
  // The end-to-end test pins the answer (SB_TEST_ACCESSIBILITY=0 or 1) so it doesn't depend on this Mac's settings.
  const pinned = process.env.SB_TEST_ACCESSIBILITY;
  if (pinned === '0' || pinned === '1') return { accessibility: pinned === '1', applies: true };
  return { accessibility: systemPreferences.isTrustedAccessibilityClient(false), applies: true };
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
