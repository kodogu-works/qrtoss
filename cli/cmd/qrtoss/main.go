package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"github.com/wistaria/qrtoss/cli/internal/client"
)

func main() {
	signal.Ignore(syscall.SIGPIPE)
	ctx, cancel := context.WithCancel(context.Background())
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	received := make(chan os.Signal, 1)
	go func() { s := <-signals; received <- s; cancel() }()
	resize := make(chan os.Signal, 1)
	signal.Notify(resize, syscall.SIGWINCH)
	r := client.Runner{Out: os.Stdout, Err: os.Stderr, Env: os.Getenv, Resize: resize}
	code := r.Run(ctx, os.Args[1:])
	select {
	case s := <-received:
		signal.Reset(s)
		_ = syscall.Kill(os.Getpid(), s.(syscall.Signal))
		if s == syscall.SIGTERM {
			code = 143
		} else {
			code = 130
		}
	default:
	}
	os.Exit(code)
}
