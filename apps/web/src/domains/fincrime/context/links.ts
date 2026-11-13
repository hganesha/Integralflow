/**
 * Typed cross-links for the Contextboard (BUILD-SPEC v2 §8.4). Routes are registered at run
 * time from the module, so paths are plain strings here.
 */
export const CONTEXT_PATH: string = "/context";
export const CONTEXT_PREVIEW_PATH: string = "/context/preview";
export const DRAFTS_PATH: string = "/studio/drafts";
export const skillPath = (skillId: string): string => `/studio/skills/definitions/${encodeURIComponent(skillId)}`;
export const draftPath = (draftId: string): string => `/studio/drafts/${encodeURIComponent(draftId)}`;

export const CONTEXT_SETUP_PATH: string = "/platform/data-sources";

export const CASE_TRAVERSAL_PATH: string = "/context/cases";
