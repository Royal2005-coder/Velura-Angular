// Package buildinfo carries values stamped in at link time by the Makefile.
package buildinfo

import "fmt"

var (
	Version = "dev"
	Commit  = "none"
	Date    = "unknown"
)

func String() string { return fmt.Sprintf("ctx %s (%s, built %s)", Version, Commit, Date) }
