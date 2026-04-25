FROM debian:bookworm-slim AS ffmpeg-builder
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    autoconf \
    automake \
    build-essential \
    ca-certificates \
    git \
    libtool \
    nasm \
    pkg-config \
    yasm \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /tmp

RUN git clone --depth 1 https://github.com/dpirch/libfvad.git && \
    cd /tmp/libfvad && \
    autoreconf -fiv && \
    ./configure --prefix=/usr/local && \
    make -j"$(nproc)" && \
    make install

RUN git clone --depth 1 --branch n8.1 https://github.com/FFmpeg/FFmpeg.git /tmp/ffmpeg

COPY af_smartvad.c /tmp/ffmpeg/libavfilter/af_smartvad.c
COPY processor/apply-ffmpeg-smartvad.sh /tmp/apply-ffmpeg-smartvad.sh
RUN chmod +x /tmp/apply-ffmpeg-smartvad.sh && /tmp/apply-ffmpeg-smartvad.sh /tmp/ffmpeg

RUN cd /tmp/ffmpeg && \
    ./configure \
      --prefix=/opt/ffmpeg \
      --disable-debug \
      --disable-doc \
      --disable-ffplay \
      --enable-gpl \
      --enable-version3 \
      --enable-libfvad \
      --enable-filter=smartvad && \
    make -j"$(nproc)" ffmpeg ffprobe && \
    make install

FROM golang:1.23-alpine AS app-builder
WORKDIR /src

COPY processor/go.mod ./go.mod
COPY processor/cmd ./cmd
COPY processor/internal ./internal

RUN CGO_ENABLED=0 GOOS=linux go build -o /out/processor ./cmd/server

FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*

COPY --from=ffmpeg-builder /opt/ffmpeg /opt/ffmpeg
COPY --from=ffmpeg-builder /usr/local/lib/libfvad.so* /usr/local/lib/
COPY --from=app-builder /out/processor /usr/local/bin/processor

ENV APP_ADDR=:8081
ENV FFMPEG_BIN=/opt/ffmpeg/bin/ffmpeg
ENV FFPROBE_BIN=/opt/ffmpeg/bin/ffprobe
ENV MAX_BODY_MB=100
ENV LD_LIBRARY_PATH=/opt/ffmpeg/lib:/usr/local/lib

EXPOSE 8081
ENTRYPOINT ["/usr/local/bin/processor"]
