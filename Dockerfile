# --- build ---
FROM docker.io/ziglang/zig:0.17.1 AS build
WORKDIR /src
COPY build.zig ./
COPY src ./src
RUN zig build -Doptimize=ReleaseFast --cache-dir /cache -p /out

# --- runtime ---
FROM docker.io/alpine:3.20
RUN adduser -D -H -u 1000 genea
COPY --from=build /out/bin/genealogie /usr/local/bin/genealogie
USER genea
ENV PORT=8080
VOLUME /data
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/genealogie"]
