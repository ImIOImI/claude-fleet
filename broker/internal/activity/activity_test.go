package activity

import (
	"os"
	"path/filepath"
	"testing"
)

func write(t *testing.T, dir, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestOf(t *testing.T) {
	dir := t.TempDir()
	r := Reader{Dir: dir}
	write(t, dir, "10.json", `{"pid":10,"sessionId":"x","status":"idle"}`)
	write(t, dir, "11.json", `{"pid":11,"sessionId":"x","status":"waiting","waitingFor":"input needed"}`)
	write(t, dir, "12.json", `{"pid":12,"sessionId":"x","status":"busy"}`)
	write(t, dir, "13.json", `{"pid":99,"sessionId":"x","status":"idle"}`)
	write(t, dir, "14.json", `{"pid":14,"status":`)
	write(t, dir, "15.json", `{"sessionId":"x","status":"idle"}`)
	write(t, dir, "18.json", `{"pid":"18","status":"idle"}`)
	cases := map[int]Kind{10: Idle, 11: Waiting, 12: Busy, 13: Busy, 14: Busy, 15: Idle, 16: Busy, 18: Busy, 0: Busy, -1: Busy}
	for pid, want := range cases {
		if got := r.Of(pid); got != want {
			t.Errorf("pid %d: got %v, want %v", pid, got, want)
		}
	}
	if (Reader{}).Of(10) != Busy {
		t.Error("no dir must read busy")
	}
}

// Shapes written by claude 2.1.281: no status before the first render, then idle → busy → waiting.
func TestOfPinnedClaudeShapes(t *testing.T) {
	dir := t.TempDir()
	r := Reader{Dir: dir}
	head := `{"pid":7,"sessionId":"cb97fd12-2ff8-4a24-a031-6a7773235110","cwd":"/workspace","startedAt":1795026635810,"procStart":"255063301","version":"2.1.281","peerProtocol":1,"peerFeatures":["notify_idle"],"kind":"interactive","entrypoint":"cli","name":"wd-9a","nameSource":"derived","nameSince":1795026635810`
	for body, want := range map[string]Kind{
		head + `}`: Busy,
		head + `,"status":"idle","updatedAt":1795026635942,"statusUpdatedAt":1795026635942}`:                                     Idle,
		head + `,"status":"busy","updatedAt":1795026641921,"statusUpdatedAt":1795026641921}`:                                     Busy,
		head + `,"status":"waiting","updatedAt":1795026652030,"statusUpdatedAt":1795026652030,"waitingFor":"permission prompt"}`: Waiting,
	} {
		write(t, dir, "7.json", body)
		if got := r.Of(7); got != want {
			t.Errorf("got %v, want %v for %s", got, want, body)
		}
	}
}

func TestOversizedFileIsBusy(t *testing.T) {
	dir := t.TempDir()
	pad := make([]byte, maxFileBytes)
	for i := range pad {
		pad[i] = ' '
	}
	write(t, dir, "8.json", `{"pid":8,"status":"idle"}`+string(pad))
	if (Reader{Dir: dir}).Of(8) != Busy {
		t.Error("oversized file must read busy")
	}
}

func TestDefaultDir(t *testing.T) {
	env := func(m map[string]string) func(string) string { return func(k string) string { return m[k] } }
	if got := DefaultDir(env(map[string]string{"HOME": "/home/fleet"})); got != "/home/fleet/.claude/sessions" {
		t.Errorf("got %q", got)
	}
	if got := DefaultDir(env(map[string]string{"HOME": "/h", "CLAUDE_FLEET_BROKER_STATUS_DIR": "/x"})); got != "/x" {
		t.Errorf("got %q", got)
	}
	if got := DefaultDir(env(nil)); got != "" {
		t.Errorf("got %q", got)
	}
}
