package portscan

import (
	"sort"
	"strings"
	"testing"
)

// Two LISTEN rows (st=0A) on ports 0x0BB8=3000 and 0x1F90=8080, plus an
// ESTABLISHED row (st=01) that must be ignored. Header line is skipped.
const sampleProcNet = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000 100 0 0 10 0
   1: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12346 1 0000 100 0 0 10 0
   2: 0100007F:C001 0100007F:0BB8 01 00000000:00000000 00:00000000 00000000  1000        0 12347 1 0000 100 0 0 10 0
`

func TestParseProcNet_OnlyListenPorts(t *testing.T) {
	into := map[uint16]struct{}{}
	if err := parseProcNet(strings.NewReader(sampleProcNet), into); err != nil {
		t.Fatalf("parse: %v", err)
	}
	got := make([]uint16, 0, len(into))
	for p := range into {
		got = append(got, p)
	}
	sort.Slice(got, func(i, j int) bool { return got[i] < got[j] })
	want := []uint16{3000, 8080}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestParseProcNet_DedupesAcrossCalls(t *testing.T) {
	into := map[uint16]struct{}{}
	_ = parseProcNet(strings.NewReader(sampleProcNet), into)
	_ = parseProcNet(strings.NewReader(sampleProcNet), into)
	if len(into) != 2 {
		t.Fatalf("expected 2 deduped ports, got %d", len(into))
	}
}
