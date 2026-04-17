package main

import (
	"fmt"
	"net/http"

	"golang.org/x/net/http2"
	"golang.org/x/net/http2/h2c"

	"github.com/fivesfromf/helpme/internal/gen/v1/helpmev1connect"
	"github.com/fivesfromf/helpme/internal/services"
)

func main() {
	citizenServer := &services.CitizenServer{}
	
	mux := http.NewServeMux()
	path, handler := helpmev1connect.NewCitizenServiceHandler(citizenServer)
	mux.Handle(path, handler)

	fmt.Println("HelpMe Backend starting on :8080...")
	// Use h2c so we can serve HTTP/2 without TLS (for development/testing through proxies)
	http.ListenAndServe(
		":8080",
		h2c.NewHandler(mux, &http2.Server{}),
	)
}
