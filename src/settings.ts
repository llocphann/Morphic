// Canonical settings implementation is retained byte-for-byte in settings-core.ts.
// This entrypoint layers the lightweight preset workspace on top without
// changing matching, rendering, or editor semantics.
export * from "./settings-core";

import { installMorphicSettingsPresetUi } from "./settings-preset-ui";

installMorphicSettingsPresetUi();
