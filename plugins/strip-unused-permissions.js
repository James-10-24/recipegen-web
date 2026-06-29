// Expo config plugin: strip unused iOS permission descriptions.
//
// Expo's prebuild template (or a transitive dep — likely the Xcode default
// when ios/ was first generated) leaves NSFaceIDUsageDescription and
// NSMicrophoneUsageDescription in Info.plist. The app doesn't use Face ID
// or the microphone. Apple's review process flags declared-but-unused
// permission strings ("why is this app asking for X?") — and on
// resubmission they'll trigger a back-and-forth that delays approval.
//
// Camera + Photo Library descriptions are LEGITIMATELY needed (snap-to-
// pantry uses both via expo-image-picker) and stay untouched.
//
// This plugin runs during `expo prebuild` and deletes the two unused keys
// so a clean rebuild of ios/ doesn't reintroduce them.

const { withInfoPlist } = require('@expo/config-plugins');

const KEYS_TO_STRIP = [
  'NSFaceIDUsageDescription',
  'NSMicrophoneUsageDescription',
];

function withStripUnusedPermissions(config) {
  return withInfoPlist(config, (cfg) => {
    for (const key of KEYS_TO_STRIP) {
      if (key in cfg.modResults) {
        delete cfg.modResults[key];
      }
    }
    return cfg;
  });
}

module.exports = withStripUnusedPermissions;
