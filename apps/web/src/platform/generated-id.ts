import { useState } from "react";

/** Stable for this form, readable from its name, and unique across concurrent authors. */
export function generatedId(
  name: string,
  nonce: string,
  prefix = "",
  maxLength = 100,
  suffix = "",
): string {
  const normalized =
    name
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "new";
  const slug = /^[a-z]/.test(normalized) ? normalized : `item-${normalized}`;
  const available =
    maxLength - prefix.length - nonce.length - suffix.length - 1;
  return `${prefix}${slug.slice(0, available).replace(/-$/, "")}-${nonce}${suffix}`;
}

/** Explicit edits and existing IDs survive name changes; new IDs need no typing. */
export function useGeneratedId(
  initial?: string,
  prefix = "",
  maxLength = 100,
  suffix = "",
) {
  const [nonce, setNonce] = useState(() => crypto.randomUUID().slice(0, 8));
  const [override, setOverride] = useState<string | undefined>(
    initial || undefined,
  );
  return {
    reset: () => {
      setOverride(undefined);
      setNonce(crypto.randomUUID().slice(0, 8));
    },
    idFor: (name: string) =>
      override ?? generatedId(name, nonce, prefix, maxLength, suffix),
    setId: setOverride,
  };
}
