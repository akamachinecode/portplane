//go:build windows

package privileged

import (
	"context"
	"errors"
	"io"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

// On Windows UAC asks, through ShellExecuteEx with the "runas" verb on the
// helper.

func method() string { return "uac" }

var (
	shell32             = windows.NewLazySystemDLL("shell32.dll")
	procShellExecuteExW = shell32.NewProc("ShellExecuteExW")
)

type shellExecuteInfo struct {
	cbSize       uint32
	fMask        uint32
	hwnd         uintptr
	lpVerb       *uint16
	lpFile       *uint16
	lpParameters *uint16
	lpDirectory  *uint16
	nShow        int32
	hInstApp     uintptr
	lpIDList     uintptr
	lpClass      *uint16
	hkeyClass    uintptr
	dwHotKey     uint32
	hIcon        uintptr
	hProcess     windows.Handle
}

const (
	seeMaskNoCloseProcess = 0x00000040
	seeMaskNoAsync        = 0x00000100
	seeMaskFlagNoUI       = 0x00000400
	swHide                = 0
	errorCancelled        = windows.Errno(1223)
)

func run(ctx context.Context, c Command, out io.Writer) error {
	return runViaHelper(ctx, c, out, func(ctx context.Context, self string, args []string) error {
		quoted := make([]string, len(args))
		for i, a := range args {
			quoted[i] = windows.EscapeArg(a)
		}
		verb, _ := windows.UTF16PtrFromString("runas")
		file, err := windows.UTF16PtrFromString(self)
		if err != nil {
			return err
		}
		params, err := windows.UTF16PtrFromString(strings.Join(quoted, " "))
		if err != nil {
			return err
		}
		info := shellExecuteInfo{
			fMask:        seeMaskNoCloseProcess | seeMaskNoAsync | seeMaskFlagNoUI,
			lpVerb:       verb,
			lpFile:       file,
			lpParameters: params,
			nShow:        swHide,
		}
		info.cbSize = uint32(unsafe.Sizeof(info))
		r, _, callErr := procShellExecuteExW.Call(uintptr(unsafe.Pointer(&info)))
		if r == 0 {
			if errors.Is(callErr, errorCancelled) {
				return ErrDenied
			}
			return callErr
		}
		if info.hProcess == 0 {
			return errors.New("the command did not start")
		}
		defer func() { _ = windows.CloseHandle(info.hProcess) }()
		done := make(chan struct{})
		go func() {
			_, _ = windows.WaitForSingleObject(info.hProcess, windows.INFINITE)
			close(done)
		}()
		select {
		case <-done:
		case <-ctx.Done():
			// The elevated process is out of reach; it finishes on its own.
			return ctx.Err()
		}
		return nil
	})
}
