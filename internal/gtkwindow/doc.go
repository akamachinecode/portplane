// Package gtkwindow is the Portplane window on Linux: a GTK 4 window with a
// WebKitGTK 6.0 web view, run as its own process (portplane-window) so the
// portplane binary stays static and starts on machines without a desktop
// (ADR-0018). GTK and WebKit are loaded at run time with purego, so this
// builds without CGO too.
package gtkwindow
