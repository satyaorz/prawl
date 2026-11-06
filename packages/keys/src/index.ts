export { deriveWalletKeys, LABELS, type WalletKeys } from "./derive";
export { seal, open, type Sealed } from "./vault";
export { createPasskey, unlockWithPasskey, encodeUserHandle, decodeUserHandle, bornAtFrom, passkeysAvailable, PasskeyError, type PasskeyRoot } from "./passkey";
