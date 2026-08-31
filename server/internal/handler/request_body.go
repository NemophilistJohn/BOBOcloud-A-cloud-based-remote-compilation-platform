package handler

import (
	"errors"
	"net"
	"net/http"
	"os"
	"sync"
	"time"
)

func limitRequestBodyRead(w http.ResponseWriter, timeout time.Duration) func() {
	if timeout <= 0 {
		return func() {}
	}
	controller := http.NewResponseController(w)
	if err := controller.SetReadDeadline(time.Now().Add(timeout)); err != nil {
		return func() {}
	}
	var once sync.Once
	return func() {
		once.Do(func() { _ = controller.SetReadDeadline(time.Time{}) })
	}
}

func requestBodyReadTimedOut(err error) bool {
	if errors.Is(err, os.ErrDeadlineExceeded) {
		return true
	}
	var networkError net.Error
	return errors.As(err, &networkError) && networkError.Timeout()
}
