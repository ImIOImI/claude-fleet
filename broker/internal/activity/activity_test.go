package activity

import (
	"bytes"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// stat stubs /proc/<pid>/stat field 22; pids 10–18 started at "100".
func stat(pid int) (string, bool) { return "100", true }

func rd(dir string) Reader { return Reader{Dir: dir, ProcStart: stat} }

func write(t *testing.T, dir, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestOf(t *testing.T) {
	dir := t.TempDir()
	r := rd(dir)
	write(t, dir, "10.json", `{"pid":10,"procStart":"100","sessionId":"x","status":"idle"}`)
	write(t, dir, "11.json", `{"pid":11,"procStart":"100","sessionId":"x","status":"waiting","waitingFor":"input needed"}`)
	write(t, dir, "12.json", `{"pid":12,"procStart":"100","sessionId":"x","status":"busy"}`)
	write(t, dir, "13.json", `{"pid":99,"procStart":"100","sessionId":"x","status":"idle"}`)
	write(t, dir, "14.json", `{"pid":14,"procStart":"100","status":`)
	write(t, dir, "15.json", `{"procStart":"100","sessionId":"x","status":"idle"}`)
	write(t, dir, "17.json", `{"pid":17,"procStart":"99","status":"idle"}`)
	write(t, dir, "18.json", `{"pid":"18","procStart":"100","status":"idle"}`)
	write(t, dir, "19.json", `{"pid":19,"status":"idle"}`)
	// 15: no pid (D144); 17: a reused pid's stale file; 19: no procStart.
	cases := map[int]Kind{10: Idle, 11: Waiting, 12: Busy, 13: Busy, 14: Busy, 15: Busy, 16: Busy, 17: Busy, 18: Busy, 19: Busy, 0: Busy, -1: Busy}
	for pid, want := range cases {
		if got := r.Of(pid); got != want {
			t.Errorf("pid %d: got %v, want %v", pid, got, want)
		}
	}
	if (Reader{ProcStart: stat}).Of(10) != Busy {
		t.Error("no dir must read busy")
	}
}

// Shapes written by claude 2.1.281: no status before the first render, then idle → busy → waiting.
func TestOfPinnedClaudeShapes(t *testing.T) {
	dir := t.TempDir()
	r := rd(dir)
	head := `{"pid":7,"sessionId":"cb97fd12-2ff8-4a24-a031-6a7773235110","cwd":"/workspace","startedAt":1795026635810,"procStart":"100","version":"2.1.281","peerProtocol":1,"peerFeatures":["notify_idle"],"kind":"interactive","entrypoint":"cli","name":"wd-9a","nameSource":"derived","nameSince":1795026635810`
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
	write(t, dir, "8.json", `{"pid":8,"procStart":"100","status":"idle"}`+string(pad))
	if rd(dir).Of(8) != Busy {
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

func TestSizeLimitBoundary(t *testing.T) {
	dir := t.TempDir()
	body := `{"pid":8,"procStart":"100","status":"idle"}`
	pad := func(n int) string { return string(bytes.Repeat([]byte(" "), n)) }
	write(t, dir, "8.json", body+pad(maxFileBytes-len(body)))
	if rd(dir).Of(8) != Idle {
		t.Fatal("a file of exactly the limit must parse")
	}
	write(t, dir, "8.json", body+pad(maxFileBytes-len(body)+1))
	if rd(dir).Of(8) != Busy {
		t.Fatal("one byte over the limit must read busy")
	}
}

func TestNonRegularFilesAreBusy(t *testing.T) {
	dir := t.TempDir()
	if err := syscall.Mkfifo(filepath.Join(dir, "20.json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/dev/zero", filepath.Join(dir, "21.json")); err != nil {
		t.Fatal(err)
	}
	write(t, dir, "target.json", `{"pid":22,"procStart":"100","status":"idle"}`)
	if err := os.Symlink(filepath.Join(dir, "target.json"), filepath.Join(dir, "22.json")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "23.json"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(filepath.Join(dir, "24.json"), 0o600); err != nil {
		t.Fatal(err)
	}
	// A held-open writer that never writes: a plain read would block forever.
	w, err := os.OpenFile(filepath.Join(dir, "24.json"), os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	r := rd(dir)
	for _, pid := range []int{20, 21, 22, 23, 24} {
		done := make(chan Kind, 1)
		go func() { done <- r.Of(pid) }()
		select {
		case k := <-done:
			if k != Busy {
				t.Errorf("pid %d: got %v", pid, k)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("pid %d: read blocked", pid)
		}
	}
}

func TestProcStartFromProc(t *testing.T) {
	pid := os.Getpid()
	got, ok := procStart(pid)
	if !ok || got == "" {
		t.Fatalf("procStart(self) = %q %v", got, ok)
	}
	if _, err := strconv.ParseUint(got, 10, 64); err != nil {
		t.Fatalf("not a tick count: %q", got)
	}
	dir := t.TempDir()
	write(t, dir, strconv.Itoa(pid)+".json", `{"pid":`+strconv.Itoa(pid)+`,"procStart":"`+got+`","status":"idle"}`)
	if (Reader{Dir: dir}).Of(pid) != Idle {
		t.Fatal("default reader must match the live process")
	}
	write(t, dir, strconv.Itoa(pid)+".json", `{"pid":`+strconv.Itoa(pid)+`,"procStart":"1`+got+`","status":"idle"}`)
	if (Reader{Dir: dir}).Of(pid) != Busy {
		t.Fatal("stale procStart must read busy")
	}
}

func TestMissingProcStartIsLoggedOnce(t *testing.T) {
	var lines []string
	missingProcStart, logf = sync.Once{}, func(f string, a ...any) { lines = append(lines, fmt.Sprintf(f, a...)) }
	t.Cleanup(func() { missingProcStart, logf = sync.Once{}, log.Printf })
	dir := t.TempDir()
	write(t, dir, "10.json", `{"pid":10,"status":"idle"}`)
	write(t, dir, "11.json", `{"pid":11,"status":"idle"}`)
	write(t, dir, "12.json", `{"pid":12,"procStart":"100","status":"idle"}`)
	for _, pid := range []int{10, 11, 10, 12} {
		want := Busy
		if pid == 12 {
			want = Idle
		}
		if got := rd(dir).Of(pid); got != want {
			t.Fatalf("pid %d: %v", pid, got)
		}
	}
	if len(lines) != 1 || !strings.Contains(lines[0], "no procStart") {
		t.Fatalf("logged %q", lines)
	}
}
