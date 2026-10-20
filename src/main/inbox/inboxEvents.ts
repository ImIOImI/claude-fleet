// In-process change signal for the inbox + notifications (#407 Phase 2b):
// fired after any write that can move the "needs you" count, so desktop
// presence (tray / taskbar overlay / dock badge) can refresh.
import { EventEmitter } from 'node:events';

export const inboxEvents = new EventEmitter();
inboxEvents.setMaxListeners(20);

export function emitInboxChanged(): void {
  inboxEvents.emit('changed');
}
