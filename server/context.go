package main

import "context"

type ctxKey string

const usernameKey ctxKey = "username"

func withUsername(ctx context.Context, username string) context.Context {
	return context.WithValue(ctx, usernameKey, username)
}

func usernameFrom(ctx context.Context) string {
	u, _ := ctx.Value(usernameKey).(string)
	return u
}
