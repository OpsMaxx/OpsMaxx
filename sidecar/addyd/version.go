package main

import "runtime"

func goVersion() string { return runtime.Version() }

// goroutineCount is the leak budget's read-out. In version.go rather than
// rtc.go so that the crypto build has it too -- a number nobody can see is a
// leak nobody finds.
func goroutineCount() int { return runtime.NumGoroutine() }
