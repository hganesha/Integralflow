/** No supported Experience API operation uses a blanket unavailable handler.
 * Configuration-dependent readers and execution routes report their own precise errors.
 * Retired unowned presentation proposals return 404.
 */
export const UNAVAILABLE: Readonly<Record<string, {owner: string; action: string; reason: string}>> = {};
