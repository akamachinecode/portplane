package main

import "net/http"

// dekitHandlers serves the dekit center: runners, task actions, why, config editing, spawn, output (M5.3, M5.4, ADR-0021, ADR-0022).
func dekitHandlers(d deps) map[string]http.HandlerFunc {
	_ = d
	return nil
}

func init() { areas = append(areas, dekitHandlers) }
