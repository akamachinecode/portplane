package main

import "net/http"

// portlessHandlers serves the portless center: proxy, routes, aliases, names, certificates, hosts, doctor (M5.2, ADR-0023).
func portlessHandlers(d deps) map[string]http.HandlerFunc {
	_ = d
	return nil
}

func init() { areas = append(areas, portlessHandlers) }
