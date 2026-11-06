/** `text` cut to `max` chars, marked when cut. */
export function clipText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [truncated ${text.length - max} chars]`;
}
