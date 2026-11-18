// Package notify wakes WATCH connections when sessions or the drain phase change.
package notify

import "sync"

type Bus struct {
	mu   sync.Mutex
	subs map[chan struct{}]struct{}
}

// Subscribe returns a wake-up channel (buffer 1, so bursts coalesce) and its cancel.
func (b *Bus) Subscribe() (<-chan struct{}, func()) {
	ch := make(chan struct{}, 1)
	b.mu.Lock()
	if b.subs == nil {
		b.subs = map[chan struct{}]struct{}{}
	}
	b.subs[ch] = struct{}{}
	b.mu.Unlock()
	return ch, func() {
		b.mu.Lock()
		delete(b.subs, ch)
		b.mu.Unlock()
	}
}

func (b *Bus) Notify() {
	b.mu.Lock()
	defer b.mu.Unlock()
	for ch := range b.subs {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}
