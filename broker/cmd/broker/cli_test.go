package main

import (
	"bytes"
	"context"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/ImIOImI/claude-fleet/broker/internal/activity"
	"github.com/ImIOImI/claude-fleet/broker/internal/drain"
	"github.com/ImIOImI/claude-fleet/broker/internal/notify"
	"github.com/ImIOImI/claude-fleet/broker/internal/server"
	"github.com/ImIOImI/claude-fleet/broker/internal/session"
)

// procWithPpid fakes /proc with this process's parent set to ppid; 0 is outside the pid namespace.
func procWithPpid(t *testing.T, ppid int) string {
	t.Helper()
	root := t.TempDir()
	writeStat(t, root, ppid)
	return root
}

func writeStat(t *testing.T, root string, ppid int) {
	t.Helper()
	dir := filepath.Join(root, strconv.Itoa(os.Getpid()))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "stat"), []byte(fmt.Sprintf("%d (go) S %d 0 0", os.Getpid(), ppid)), 0o644); err != nil {
		t.Fatal(err)
	}
}

func controlRig(t *testing.T) (string, *drain.Drainer) {
	t.Helper()
	path, d, _ := controlServer(t)
	return path, d
}

func controlServer(t *testing.T) (string, *drain.Drainer, *server.Server) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "ctl.sock")
	bus := &notify.Bus{}
	mgr := session.NewManager(session.ManagerConfig{ClaudeExec: "/bin/cat", OnChange: bus.Notify})
	d := drain.New(drain.Config{Soft: time.Minute, Hard: 2 * time.Minute, FirstPass: 10 * time.Millisecond, Poll: 10 * time.Millisecond, EscEvery: time.Minute},
		mgr, func(int) activity.Kind { return activity.Idle }, time.Now, "i", bus)
	srv := server.New(mgr)
	srv.Drain, srv.Bus = d, bus
	srv.ProcRoot = procWithPpid(t, 0)
	ln, err := listenCtl(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	go func() { _ = srv.ServeControl(ctx, ln) }()
	go d.Run(ctx)
	t.Cleanup(func() { cancel(); ln.Close(); mgr.CloseAll() })
	return path, d, srv
}

func TestReadyThenDrainReturnsWhenDone(t *testing.T) {
	path, d := controlRig(t)
	env := envOf(map[string]string{"CLAUDE_FLEET_BROKER_CTL_SOCKET": path})
	var out, errOut bytes.Buffer
	if code := runCLI([]string{"ready"}, env, &out, &errOut); code != 0 {
		t.Fatalf("ready while serving: %d %s", code, errOut.String())
	}
	if code := runCLI([]string{"drain"}, env, &out, &errOut); code != 0 {
		t.Fatalf("drain: %d %s", code, errOut.String())
	}
	if !strings.Contains(out.String(), `"phase":"done"`) || d.Phase() != drain.PhaseDone {
		t.Fatalf("output %q phase %s", out.String(), d.Phase())
	}
	if code := runCLI([]string{"ready"}, env, &out, &errOut); code != 1 {
		t.Fatalf("ready after drain: %d", code)
	}
}

func TestDrainFromInsideTheNamespaceFails(t *testing.T) {
	path, d, srv := controlServer(t)
	writeStat(t, srv.ProcRoot, 1)
	env := envOf(map[string]string{"CLAUDE_FLEET_BROKER_CTL_SOCKET": path})
	var out, errOut bytes.Buffer
	if code := runCLI([]string{"drain"}, env, &out, &errOut); code != 1 || !strings.Contains(errOut.String(), "broker drain: refused") {
		t.Fatalf("drain: %d %q", code, errOut.String())
	}
	if d.Phase() != drain.PhaseServing {
		t.Fatal("drain started")
	}
}

func TestCLIWithoutBrokerAndUsage(t *testing.T) {
	env := envOf(map[string]string{"CLAUDE_FLEET_BROKER_CTL_SOCKET": filepath.Join(t.TempDir(), "none.sock")})
	var out, errOut bytes.Buffer
	if code := runCLI([]string{"drain"}, env, &out, &errOut); code != 1 {
		t.Fatalf("drain without broker: %d", code)
	}
	if code := runCLI([]string{"ready"}, env, &out, &errOut); code != 1 {
		t.Fatalf("ready without broker: %d", code)
	}
	if code := runCLI([]string{"bogus"}, env, &out, &errOut); code != 2 {
		t.Fatalf("usage: %d", code)
	}
}

func TestControlSocketIsOwnerOnly(t *testing.T) {
	path, _ := controlRig(t)
	if fi, err := os.Stat(path); err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v %v", fi.Mode().Perm(), err)
	}
}

// Mode 0600 from the first instant: a permissive umask must not leak into the bind.
func TestControlSocketIsOwnerOnlyUnderAnOpenUmask(t *testing.T) {
	old := syscall.Umask(0)
	defer syscall.Umask(old)
	var seen os.FileMode
	path := filepath.Join(t.TempDir(), "ctl.sock")
	ln, err := listenCtlHook(context.Background(), path, func() {
		if fi, err := os.Lstat(path); err == nil {
			seen = fi.Mode().Perm()
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if seen != 0o600 {
		t.Fatalf("mode right after bind %v", seen)
	}
	if now := syscall.Umask(0); now != 0 {
		t.Fatalf("umask not restored: %o", now)
	}
}

func TestControlSocketReplacesOnlyAStaleSocket(t *testing.T) {
	dir := t.TempDir()
	stale := filepath.Join(dir, "ctl.sock")
	l, err := net.Listen("unix", stale)
	if err != nil {
		t.Fatal(err)
	}
	l.(*net.UnixListener).SetUnlinkOnClose(false)
	l.Close()
	ln, err := listenCtl(context.Background(), stale)
	if err != nil {
		t.Fatalf("stale socket not replaced: %v", err)
	}
	ln.Close()
	if _, err := os.Lstat(stale); !os.IsNotExist(err) {
		t.Fatalf("socket left behind on close: %v", err)
	}
	for name, mk := range map[string]func(string) error{
		"file":    func(p string) error { return os.WriteFile(p, nil, 0o600) },
		"symlink": func(p string) error { return os.Symlink("/etc/passwd", p) },
		"dir":     func(p string) error { return os.Mkdir(p, 0o700) },
	} {
		p := filepath.Join(dir, name+".sock")
		if err := mk(p); err != nil {
			t.Fatal(err)
		}
		if ln, err := listenCtl(context.Background(), p); err == nil {
			ln.Close()
			t.Errorf("%s: replaced a non-socket", name)
		}
		if _, err := os.Lstat(p); err != nil {
			t.Errorf("%s: removed: %v", name, err)
		}
	}
}

func TestControlSocketOnlyWhenDrainIsOn(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ctl.sock")
	env := envOf(map[string]string{"CLAUDE_FLEET_BROKER_CTL_SOCKET": path})
	ln, err := openControl(context.Background(), false, env)
	if err != nil || ln != nil {
		t.Fatalf("drain off opened %v %v", ln, err)
	}
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Fatal("control socket exists with drain off")
	}
	ln, err = openControl(context.Background(), true, env)
	if err != nil || ln == nil {
		t.Fatalf("drain on: %v", err)
	}
	ln.Close()
}

type fakeDrain struct {
	started atomic.Int32
	done    chan struct{}
}

func (f *fakeDrain) Start() bool           { return f.started.Add(1) == 1 }
func (f *fakeDrain) Phase() string         { return drain.PhaseDraining }
func (f *fakeDrain) Done() <-chan struct{} { return f.done }

func signalRig(drainOn bool) (chan os.Signal, *fakeDrain, chan struct{}) {
	return signalRigFlush(drainOn, 0)
}

func signalRigFlush(drainOn bool, flush time.Duration) (chan os.Signal, *fakeDrain, chan struct{}) {
	sig := make(chan os.Signal, 4)
	f := &fakeDrain{done: make(chan struct{})}
	stopped := make(chan struct{})
	go handleSignals(sig, drainOn, f, flush, func() { close(stopped) })
	return sig, f, stopped
}

func stoppedWithin(ch chan struct{}, d time.Duration) bool {
	select {
	case <-ch:
		return true
	case <-time.After(d):
		return false
	}
}

func TestSigtermDrainsWhenEnabled(t *testing.T) {
	sig, f, stopped := signalRig(true)
	sig <- syscall.SIGTERM
	sig <- syscall.SIGTERM
	if stoppedWithin(stopped, 100*time.Millisecond) {
		t.Fatal("SIGTERM stopped before the drain was done")
	}
	close(f.done)
	if !stoppedWithin(stopped, time.Second) {
		t.Fatal("not stopped once the drain was done")
	}
	sig <- syscall.SIGINT // a late signal must not stop twice
	time.Sleep(50 * time.Millisecond)
	if n := f.started.Load(); n != 2 {
		t.Fatalf("Start called %d times", n)
	}
}

func TestDoneWaitsForWatchFlushThenStops(t *testing.T) {
	sig, f, stopped := signalRigFlush(true, 300*time.Millisecond)
	sig <- syscall.SIGTERM
	close(f.done)
	if stoppedWithin(stopped, 150*time.Millisecond) {
		t.Fatal("stopped before the WATCH flush window")
	}
	if !stoppedWithin(stopped, time.Second) {
		t.Fatal("not stopped after the flush window")
	}
}

func TestSigintDuringFlushStopsAtOnce(t *testing.T) {
	sig, f, stopped := signalRigFlush(true, time.Minute)
	sig <- syscall.SIGTERM
	close(f.done)
	sig <- syscall.SIGINT
	if !stoppedWithin(stopped, time.Second) {
		t.Fatal("SIGINT did not cut the flush short")
	}
}

func TestSigintClosesAtOnceEvenWhileDraining(t *testing.T) {
	sig, _, stopped := signalRig(true)
	sig <- syscall.SIGTERM
	sig <- syscall.SIGINT
	if !stoppedWithin(stopped, time.Second) {
		t.Fatal("SIGINT did not stop at once")
	}
}

func TestSigtermClosesAtOnceWhenDrainIsOff(t *testing.T) {
	sig, f, stopped := signalRig(false)
	sig <- syscall.SIGTERM
	if !stoppedWithin(stopped, time.Second) || f.started.Load() != 0 {
		t.Fatalf("drain off: stopped? started=%d", f.started.Load())
	}
}
