# syntax=docker/dockerfile:1
FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/acnh-server .

FROM alpine:3.20
RUN adduser -D -H -u 10001 acnh
COPY --from=build /out/acnh-server /usr/local/bin/acnh-server
USER acnh
ENV DATA_DIR=/data \
    PORT=8080
VOLUME ["/data"]
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/acnh-server"]
