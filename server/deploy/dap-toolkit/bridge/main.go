package main

import (
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"
)

func main() {
	if err := run(); err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "dap-stdio-bridge: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	listen := flag.String("listen", "127.0.0.1:4711", "adapter loopback address")
	timeout := flag.Duration("ready-timeout", 15*time.Second, "adapter startup timeout")
	flag.Parse()
	command := flag.Args()
	if len(command) > 0 && command[0] == "--" {
		command = command[1:]
	}
	if len(command) == 0 {
		return fmt.Errorf("adapter command is required")
	}
	child := exec.Command(command[0], command[1:]...)
	// TCP carries DAP. Adapter stdout and stderr are diagnostics and must stay
	// away from this bridge's framed stdout channel.
	child.Stdout, child.Stderr = os.Stderr, os.Stderr
	child.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := child.Start(); err != nil {
		return fmt.Errorf("start adapter: %w", err)
	}
	exited := make(chan error, 1)
	go func() { exited <- child.Wait() }()
	defer func() {
		if child.Process != nil {
			_ = syscall.Kill(-child.Process.Pid, syscall.SIGTERM)
			time.Sleep(200 * time.Millisecond)
			_ = syscall.Kill(-child.Process.Pid, syscall.SIGKILL)
		}
	}()
	connection, err := waitForAdapter(*listen, *timeout, exited)
	if err != nil {
		return fmt.Errorf("adapter did not become ready: %w", err)
	}
	defer connection.Close()
	done := make(chan error, 2)
	go func() {
		_, copyErr := io.Copy(connection, os.Stdin)
		if tcp, ok := connection.(*net.TCPConn); ok {
			_ = tcp.CloseWrite()
		}
		done <- copyErr
	}()
	go func() {
		_, copyErr := io.Copy(os.Stdout, connection)
		done <- copyErr
	}()
	if err := <-done; err != nil && !strings.Contains(err.Error(), "closed") {
		return fmt.Errorf("bridge DAP stream: %w", err)
	}
	return nil
}

func waitForAdapter(address string, timeout time.Duration, exited <-chan error) (net.Conn, error) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		select {
		case err := <-exited:
			return nil, fmt.Errorf("adapter exited: %v", err)
		default:
		}
		connection, err := net.DialTimeout("tcp", address, 200*time.Millisecond)
		if err == nil {
			return connection, nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	return nil, fmt.Errorf("timed out connecting to %s", address)
}
