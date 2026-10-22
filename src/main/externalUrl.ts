// Gate for every URL the renderer asks the OS to open (setWindowOpenHandler).
// Only real web links leave the app. Anything else — notably `about:blank`,
// which xterm's built-in OSC 8 handler opens before assigning the real href —
// would hand Windows a protocol with no registered app, and Windows answers
// that by sending the user to the Microsoft Store for an "About" app.
export function isOpenableExternalUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}
