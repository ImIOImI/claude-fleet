package notify

import "testing"

func TestNotifyWakesEverySubscriberWithoutBlocking(t *testing.T) {
	var b Bus
	a, cancelA := b.Subscribe()
	c, cancelC := b.Subscribe()
	defer cancelC()
	b.Notify()
	b.Notify() // coalesces: the buffer holds one wake-up
	for _, ch := range []<-chan struct{}{a, c} {
		select {
		case <-ch:
		default:
			t.Fatal("subscriber not woken")
		}
		select {
		case <-ch:
			t.Fatal("two wake-ups were not coalesced")
		default:
		}
	}
	cancelA()
	b.Notify()
	select {
	case <-a:
		t.Fatal("cancelled subscriber woken")
	default:
	}
}
