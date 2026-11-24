// Command default-config writes the same default configuration used by the server.
package main

import (
	"fmt"
	"os"

	"bobocloud-server/internal/config"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: default-config OUTPUT")
		os.Exit(2)
	}
	if err := config.WriteDefault(os.Args[1]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
