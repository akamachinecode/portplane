package main

import "net/http"

// toolsHandlers serves the guided setup: system check, installing dekit, Node and portless, the proxy service, browser trust (M5.1, ADR-0019, ADR-0020).
func toolsHandlers(d deps) map[string]http.HandlerFunc {
	_ = d
	return nil
}

func init() { areas = append(areas, toolsHandlers) }
