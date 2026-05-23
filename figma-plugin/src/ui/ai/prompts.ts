// Build-inlined system prompts for the AI checks.
//
// Each `export const` below is a string literal containing a comment-shaped
// marker. `scripts/build.mjs` rewrites each marker at bundle time to the
// JSON-escaped contents of `assets/prompts/<name>.txt`, so the prompt body
// ships in `dist/ui.html` with no runtime fetch.
//
// Source of truth lives in:
//   assets/prompts/visual-review.txt
//   assets/prompts/image-of-text.txt
//   assets/prompts/alt-text.txt
//
// To edit a prompt, change the .txt file and re-build (or save while
// `npm run dev` is watching). Don't edit the strings here directly — the
// build will overwrite them on the next compile.

export const VISUAL_REVIEW_PROMPT = '/* INLINE_VISUAL_REVIEW_PROMPT */'

export const IMAGE_OF_TEXT_PROMPT = '/* INLINE_IMAGE_OF_TEXT_PROMPT */'

export const ALT_TEXT_PROMPT = '/* INLINE_ALT_TEXT_PROMPT */'
