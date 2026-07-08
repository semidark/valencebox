FROM i386/alpine:3.22.5 AS builder

RUN apk add --no-cache \
    build-base \
    cargo \
    rust

WORKDIR /app

COPY Cargo.toml Cargo.lock ./
RUN mkdir src
RUN printf 'fn main() {}\n' > src/main.rs
RUN cargo build --release

COPY src ./src
RUN touch src/main.rs && cargo build --release

FROM i386/alpine:3.22.5 AS runtime

RUN apk add --no-cache \
    ca-certificates \
    libgcc \
    curl \
    file \
    wget \
    bash \
    find \
    ripgrep


COPY --from=builder /app/target/release/agent /usr/local/bin/agent

ENTRYPOINT ["/usr/local/bin/agent"]
