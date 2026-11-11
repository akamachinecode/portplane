//go:build darwin && cgo

package tray

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa
#import <Cocoa/Cocoa.h>
#include <stdatomic.h>

// Opening Portplane.app again while it runs sends a "reopen" Apple event to
// the running process instead of starting a new one. The handler only counts
// them; Go polls the count (no callbacks across the cgo boundary).
static atomic_int ppReopens = 0;

@interface PPReopen : NSObject
- (void)handle:(NSAppleEventDescriptor *)event reply:(NSAppleEventDescriptor *)reply;
@end

@implementation PPReopen
- (void)handle:(NSAppleEventDescriptor *)event reply:(NSAppleEventDescriptor *)reply {
	atomic_fetch_add(&ppReopens, 1);
}
@end

static PPReopen *ppReopen;

static void ppRegisterReopen(void) {
	dispatch_async(dispatch_get_main_queue(), ^{
		ppReopen = [PPReopen new];
		[[NSAppleEventManager sharedAppleEventManager] setEventHandler:ppReopen
			andSelector:@selector(handle:reply:)
			forEventClass:kCoreEventClass
			andEventID:kAEReopenApplication];
	});
}

static int ppTakeReopens(void) { return atomic_exchange(&ppReopens, 0); }
*/
import "C"

import (
	"context"
	"time"
)

// watchReopen opens the window when the app is opened again from Finder,
// Spotlight or the Dock.
func watchReopen(ctx context.Context, open func()) {
	if open == nil {
		return
	}
	C.ppRegisterReopen()
	go func() {
		t := time.NewTicker(300 * time.Millisecond)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if C.ppTakeReopens() > 0 {
					open()
				}
			}
		}
	}()
}
