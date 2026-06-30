/**
 * Recognizes user-message text that is synthetic harness/slash-command wrapper
 * content rather than a real prompt, so the JSONL ingest can skip it when
 * deriving a session's `first_user_message` (see db.ts).
 *
 * A session started with a slash command (e.g. `/clear`) has its first
 * string-content `user` message be an entirely-synthetic wrapper blob; because
 * `first_user_message` is COALESCE'd (first value wins, permanently), that blob
 * would otherwise lock in as the session's fallback title.
 *
 * Conservative by design: only a message that *starts with* a known wrapper tag
 * (or is empty/whitespace) is treated as synthetic. A real prompt that merely
 * mentions a tag mid-text is kept. We never try to strip a wrapper block out of
 * an otherwise-real prompt.
 */

const WRAPPER_TAGS = [
  '<local-command-caveat>',
  '<command-name>',
  '<command-message>',
  '<command-args>',
  '<local-command-stdout>',
  '<system-reminder>',
];

export function isSyntheticPromptText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === '') return true;
  return WRAPPER_TAGS.some((tag) => trimmed.startsWith(tag));
}
