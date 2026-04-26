# Container for SKP-to-OBJ conversion via Wine.
# Wine needs a full Linux kernel — use Fargate or App Runner, NOT Lambda.
#
# Build: docker build --platform linux/amd64 -t skp-convert .
# Test:  docker run --platform linux/amd64 -p 8080:8080 skp-convert

FROM debian:bookworm-slim

# Install Wine from Debian repos (well-tested, proper packaging)
RUN dpkg --add-architecture i386 && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
    python3 \
    ca-certificates \
    wine \
    wine64 \
    wget \
    cabextract \
    && rm -rf /var/lib/apt/lists/*

# Wine environment (headless)
ENV WINEDEBUG=-all
ENV WINEARCH=win64
ENV WINEPREFIX=/tmp/wine
ENV PYTHONUNBUFFERED=1
ENV DISPLAY=

# Copy skp2obj binary and SDK DLLs
COPY skp2obj_win.exe /opt/skp2obj/skp2obj_win.exe
COPY sdk/ /opt/skp2obj/

# Download MSVC 2022 runtime DLLs (needed by SketchUpAPI.dll)
# vc_redist.x64.exe contains nested .cab files; DLLs have _amd64 suffix
RUN cd /tmp && \
    wget -q "https://aka.ms/vs/17/release/vc_redist.x64.exe" -O vcredist.exe && \
    cabextract -q vcredist.exe && \
    mkdir -p dlls && \
    for f in a*; do cabextract -q -d dlls "$f" 2>/dev/null || true; done && \
    for dll in msvcp140 msvcp140_1 msvcp140_2 msvcp140_codecvt_ids \
               vcruntime140 vcruntime140_1 concrt140; do \
      src="dlls/${dll}.dll_amd64"; \
      if [ -f "$src" ]; then \
        cp "$src" "/opt/skp2obj/${dll}.dll"; \
        echo "  Installed: ${dll}.dll"; \
      fi; \
    done && \
    echo "SDK contents:" && ls /opt/skp2obj/ && \
    rm -rf /tmp/*

# Copy server
COPY server.py /app/server.py

EXPOSE 8080
CMD ["python3", "/app/server.py"]
