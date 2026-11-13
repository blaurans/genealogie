# --- build : télécharge le toolchain Zig officiel et compile en statique ---
FROM docker.io/alpine:3.20 AS build
RUN apk add --no-cache curl xz tar
WORKDIR /src
COPY . .
RUN curl -fsSL -o /tmp/zig.tar.xz https://ziglang.org/download/0.17.1/zig-x86_64-linux-0.17.1.tar.xz \
    && mkdir -p /opt && tar -xf /tmp/zig.tar.xz -C /opt \
    && /opt/zig-x86_64-linux-0.17.1/zig build -Doptimize=ReleaseFast \
        -Dtarget=x86_64-linux-musl --cache-dir /cache -p /out

# --- runtime : image minimale, binaire statique ---
FROM docker.io/alpine:3.20
RUN adduser -D -H -u 1000 genea
COPY --from=build /out/bin/genealogie /usr/local/bin/genealogie
USER genea
ENV PORT=8080
VOLUME /data
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/genealogie"]
