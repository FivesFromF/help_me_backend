package main

import (
	"fmt"
	"net/http"
)

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "HelpMe Backend - Hello World")
	})

	fmt.Println("Server starting on :8080...")
	http.ListenAndServe(":8080", mux)
}
