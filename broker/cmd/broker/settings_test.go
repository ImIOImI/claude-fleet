package main

import (
	"strings"
	"testing"
	"time"
)

func TestDrainSettings(t *testing.T) {
	on, cfg, err := drainSettings(envOf(nil))
	if err != nil || on || cfg.Soft != 30*time.Minute || cfg.Hard != 35*time.Minute {
		t.Fatalf("defaults: %v %+v %v", on, cfg, err)
	}
	on, cfg, err = drainSettings(envOf(map[string]string{"CLAUDE_FLEET_BROKER_DRAIN": "1", "CLAUDE_FLEET_BROKER_DRAIN_SOFT": "3s", "CLAUDE_FLEET_BROKER_DRAIN_HARD": "6s"}))
	if err != nil || !on || cfg.Soft != 3*time.Second || cfg.Hard != 6*time.Second {
		t.Fatalf("override: %v %+v %v", on, cfg, err)
	}
	for _, bad := range []map[string]string{
		{"CLAUDE_FLEET_BROKER_DRAIN": "yes"},
		{"CLAUDE_FLEET_BROKER_DRAIN_SOFT": "soon"},
		{"CLAUDE_FLEET_BROKER_DRAIN_SOFT": "500ms"},
		{"CLAUDE_FLEET_BROKER_DRAIN_SOFT": "40m"},
		{"CLAUDE_FLEET_BROKER_DRAIN_HARD": "25h", "CLAUDE_FLEET_BROKER_DRAIN_SOFT": "1h"},
	} {
		if _, _, err := drainSettings(envOf(bad)); err == nil {
			t.Errorf("accepted %v", bad)
		} else if !strings.Contains(err.Error(), "CLAUDE_FLEET_BROKER_DRAIN") {
			t.Errorf("error doesn't name the variable: %v", err)
		}
	}
}

func TestDrainSettingsBounds(t *testing.T) {
	ok := []map[string]string{
		{"CLAUDE_FLEET_BROKER_DRAIN_SOFT": "1s", "CLAUDE_FLEET_BROKER_DRAIN_HARD": "2s"},
		{"CLAUDE_FLEET_BROKER_DRAIN_SOFT": "23h", "CLAUDE_FLEET_BROKER_DRAIN_HARD": "24h"},
		{"CLAUDE_FLEET_BROKER_DRAIN": "0"},
	}
	for _, m := range ok {
		if _, _, err := drainSettings(envOf(m)); err != nil {
			t.Errorf("rejected %v: %v", m, err)
		}
	}
	bad := []map[string]string{
		{"CLAUDE_FLEET_BROKER_DRAIN_SOFT": "999ms", "CLAUDE_FLEET_BROKER_DRAIN_HARD": "2s"},
		{"CLAUDE_FLEET_BROKER_DRAIN_SOFT": "5s", "CLAUDE_FLEET_BROKER_DRAIN_HARD": "5s"},
		{"CLAUDE_FLEET_BROKER_DRAIN_SOFT": "1h", "CLAUDE_FLEET_BROKER_DRAIN_HARD": "24h1s"},
		{"CLAUDE_FLEET_BROKER_DRAIN_SOFT": "-1s"},
		{"CLAUDE_FLEET_BROKER_DRAIN_HARD": "0"},
	}
	for _, m := range bad {
		if _, _, err := drainSettings(envOf(m)); err == nil {
			t.Errorf("accepted %v", m)
		}
	}
}
