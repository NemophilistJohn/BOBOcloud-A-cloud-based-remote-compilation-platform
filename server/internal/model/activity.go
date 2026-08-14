package model

// CompileActivityDay is an aggregate count of accepted runCode handshakes for
// one UTC calendar day.
type CompileActivityDay struct {
	Date  string `json:"date"`
	Count uint64 `json:"count"`
}
