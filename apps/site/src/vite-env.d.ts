/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The deployed wallet origin. Passkeys are bound to it, so it must be a real domain. */
  readonly VITE_WALLET_URL?: string;
  /** Where "Download APK" points. Defaults to the latest GitHub release. */
  readonly VITE_APK_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
