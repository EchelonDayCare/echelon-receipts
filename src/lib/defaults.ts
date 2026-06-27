// Bundled default brand assets — used as fallback when Settings is empty.
// Imported with Vite's ?inline so they ship as base64 data URLs (works in PDF rendering too).
import defaultLogo from "../assets/default-logo.png?inline";
import defaultSignature from "../assets/default-signature.jpg?inline";

export const DEFAULT_LOGO_DATA_URL: string = defaultLogo as unknown as string;
export const DEFAULT_SIGNATURE_DATA_URL: string = defaultSignature as unknown as string;
